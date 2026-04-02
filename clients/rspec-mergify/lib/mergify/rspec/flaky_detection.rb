# frozen_string_literal: true

require 'net/http'
require 'json'
require 'uri'
require 'set'
require_relative 'utils'

module Mergify
  module RSpec
    # Manages intelligent test rerunning with budget constraints for flaky detection.
    # rubocop:disable Metrics/ClassLength
    class FlakyDetector
      # Per-test tracking metrics.
      class TestMetrics
        attr_accessor :initial_setup_duration, :initial_call_duration, :initial_teardown_duration,
                      :rerun_count, :deadline, :prevented_timeout, :total_duration

        def initialize
          @initial_setup_duration = 0.0
          @initial_call_duration = 0.0
          @initial_teardown_duration = 0.0
          @rerun_count = 0
          @deadline = nil
          @prevented_timeout = false
          @total_duration = 0.0
        end

        def initial_duration
          @initial_setup_duration + @initial_call_duration + @initial_teardown_duration
        end

        def remaining_time
          return 0.0 if @deadline.nil?

          [(@deadline - Time.now.to_f), 0.0].max
        end

        def will_exceed_deadline?
          return false if @deadline.nil?

          (Time.now.to_f + initial_duration) >= @deadline
        end

        def fill_from_report(phase, duration, _status)
          case phase
          when 'setup'
            @initial_setup_duration = duration if @initial_setup_duration.zero?
          when 'call'
            @initial_call_duration = duration if @initial_call_duration.zero?
            @rerun_count += 1
          when 'teardown'
            @initial_teardown_duration = duration if @initial_teardown_duration.zero?
          end
          @total_duration += duration
        end
      end

      attr_reader :tests_to_process, :budget, :mode

      def initialize(token:, url:, full_repository_name:, mode:)
        @token = token
        @url = url
        @full_repository_name = full_repository_name
        @mode = mode
        @metrics = {}
        @over_length_tests = Set.new
        @tests_to_process = []
        @budget = 0.0

        fetch_context
        validate!
      end

      # rubocop:disable Metrics/MethodLength,Metrics/AbcSize
      def prepare_for_session(test_ids)
        existing = Set.new(@context[:existing_test_names])
        unhealthy = Set.new(@context[:unhealthy_test_names])

        @tests_to_process =
          if @mode == 'new'
            test_ids.reject { |id| existing.include?(id) }
          else
            test_ids.select { |id| unhealthy.include?(id) }
          end

        budget_ratio = if @mode == 'new'
                         @context[:budget_ratio_for_new_tests]
                       else
                         @context[:budget_ratio_for_unhealthy_tests]
                       end

        mean_duration_s = @context[:existing_tests_mean_duration_ms] / 1000.0
        existing_count = @context[:existing_test_names].size
        min_budget_s = @context[:min_budget_duration_ms] / 1000.0

        ratio_budget = budget_ratio * mean_duration_s * existing_count
        @budget = [ratio_budget, min_budget_s].max
      end
      # rubocop:enable Metrics/MethodLength,Metrics/AbcSize

      # rubocop:disable Metrics/MethodLength
      def fill_metrics_from_report(test_id, phase, duration, status)
        if status == :skipped
          @metrics.delete(test_id)
          return
        end

        return unless @tests_to_process.include?(test_id)

        if test_id.length > @context[:max_test_name_length]
          @over_length_tests.add(test_id)
          return
        end

        # Only initialize metrics when the first phase is "setup"
        return if !@metrics.key?(test_id) && phase != 'setup'

        @metrics[test_id] ||= TestMetrics.new
        @metrics[test_id].fill_from_report(phase, duration, status)
      end
      # rubocop:enable Metrics/MethodLength

      def rerunning_test?(test_id)
        @metrics.key?(test_id) && @metrics[test_id].rerun_count >= 1
      end

      def test_rerun?(test_id)
        @metrics.key?(test_id) && @metrics[test_id].rerun_count > 1
      end

      def set_test_deadline(test_id, timeout: nil)
        return unless @metrics.key?(test_id)

        remaining_tests = [remaining_tests_count, 1].max
        per_test_budget = remaining_budget / remaining_tests

        allocated =
          if timeout
            [per_test_budget, timeout * 0.9].min
          else
            per_test_budget
          end

        @metrics[test_id].deadline = Time.now.to_f + allocated
      end

      def test_too_slow?(test_id)
        return false unless @metrics.key?(test_id)

        metrics = @metrics[test_id]
        min_exec = @context[:min_test_execution_count]
        (metrics.initial_duration * min_exec) > metrics.remaining_time
      end

      def last_rerun_for_test?(test_id)
        return false unless @metrics.key?(test_id)

        metrics = @metrics[test_id]
        metrics.will_exceed_deadline? || metrics.rerun_count >= @context[:max_test_execution_count]
      end

      def test_metrics(test_id)
        @metrics[test_id]
      end

      # rubocop:disable Metrics/MethodLength,Metrics/AbcSize
      def make_report
        lines = []
        lines << 'Mergify Flaky Detection Report'
        lines << "  Mode        : #{@mode}"
        lines << "  Budget      : #{format('%.2f', @budget)}s"
        lines << "  Budget used : #{format('%.2f', budget_used)}s"
        lines << "  Tests tracked: #{@metrics.size}"
        lines << ''

        @metrics.each do |test_id, m|
          lines << "  #{test_id}"
          lines << "    Reruns       : #{m.rerun_count}"
          lines << "    Initial dur  : #{format('%.3f', m.initial_duration)}s"
          lines << "    Total dur    : #{format('%.3f', m.total_duration)}s"
          lines << "    Timeout warn : #{m.prevented_timeout}" if m.prevented_timeout
        end

        lines << '' unless @over_length_tests.empty?
        @over_length_tests.each do |id|
          lines << "  WARNING: test name too long (skipped): #{id[0, 80]}..."
        end

        lines.join("\n")
      end
      # rubocop:enable Metrics/MethodLength,Metrics/AbcSize

      private

      # rubocop:disable Metrics/AbcSize
      def fetch_context
        owner, repo = Utils.split_full_repo_name(@full_repository_name)
        uri = URI("#{@url}/v1/ci/#{owner}/repositories/#{repo}/flaky-detection-context")

        http = Net::HTTP.new(uri.host, uri.port)
        http.use_ssl = uri.scheme == 'https'
        http.open_timeout = 10
        http.read_timeout = 10

        request = Net::HTTP::Get.new(uri)
        request['Authorization'] = "Bearer #{@token}"

        response = http.request(request)
        parse_context(response.body)
      end
      # rubocop:enable Metrics/AbcSize

      # rubocop:disable Metrics/MethodLength,Metrics/AbcSize
      def parse_context(body)
        data = JSON.parse(body, symbolize_names: true)
        @context = {
          budget_ratio_for_new_tests: data[:budget_ratio_for_new_tests].to_f,
          budget_ratio_for_unhealthy_tests: data[:budget_ratio_for_unhealthy_tests].to_f,
          existing_test_names: Array(data[:existing_test_names]),
          existing_tests_mean_duration_ms: data[:existing_tests_mean_duration_ms].to_f,
          unhealthy_test_names: Array(data[:unhealthy_test_names]),
          max_test_execution_count: data[:max_test_execution_count].to_i,
          max_test_name_length: data[:max_test_name_length].to_i,
          min_budget_duration_ms: data[:min_budget_duration_ms].to_f,
          min_test_execution_count: data[:min_test_execution_count].to_i
        }
      end
      # rubocop:enable Metrics/MethodLength,Metrics/AbcSize

      def validate!
        return unless @mode == 'new' && @context[:existing_test_names].empty?

        raise 'Cannot use "new" mode without existing test names in the context'
      end

      def remaining_budget
        used = budget_used
        [@budget - used, 0.0].max
      end

      def budget_used
        @metrics.sum { |_, m| m.total_duration }
      end

      def remaining_tests_count
        @tests_to_process.count { |id| !@metrics.key?(id) || @metrics[id].deadline.nil? }
      end
    end
    # rubocop:enable Metrics/ClassLength
  end
end
