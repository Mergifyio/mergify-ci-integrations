# frozen_string_literal: true

require 'net/http'
require 'json'
require 'uri'
require 'set'
require_relative 'utils'

module Mergify
  module RSpec
    # Fetches quarantined test names from the Mergify API and tracks which are used.
    class Quarantine
      attr_reader :quarantined_tests, :init_error_msg

      def initialize(api_url:, token:, repo_name:, branch_name:)
        @repo_name = repo_name
        @branch_name = branch_name
        @quarantined_tests = []
        @used_tests = Set.new
        @init_error_msg = nil

        owner, repo = Utils.split_full_repo_name(repo_name)
        fetch_quarantined_tests(api_url, token, owner, repo, branch_name)
      rescue Utils::InvalidRepositoryFullNameError => e
        @init_error_msg = e.message
      end

      def include?(example_id)
        @quarantined_tests.include?(example_id)
      end

      def mark_as_used(example_id)
        @used_tests.add(example_id)
      end

      # rubocop:disable Metrics/MethodLength,Metrics/AbcSize
      def report
        used, unused = @quarantined_tests.partition { |t| @used_tests.include?(t) }

        lines = []
        lines << 'Mergify Quarantine Report'
        lines << "  Repository : #{@repo_name}"
        lines << "  Branch     : #{@branch_name}"
        lines << "  Quarantined tests from API: #{@quarantined_tests.size}"
        lines << ''
        lines << "  Quarantined tests run (#{used.size}):"
        used.each { |t| lines << "    - #{t}" }
        lines << ''
        lines << "  Unused quarantined tests (#{unused.size}):"
        unused.each { |t| lines << "    - #{t}" }
        lines.join("\n")
      end
      # rubocop:enable Metrics/MethodLength,Metrics/AbcSize

      private

      # rubocop:disable Metrics/MethodLength,Metrics/AbcSize
      def fetch_quarantined_tests(api_url, token, owner, repo, branch_name)
        uri = URI("#{api_url}/v1/ci/#{owner}/repositories/#{repo}/quarantines")
        uri.query = URI.encode_www_form(branch: branch_name)

        http = Net::HTTP.new(uri.host, uri.port)
        http.use_ssl = uri.scheme == 'https'
        http.open_timeout = 10
        http.read_timeout = 10

        request = Net::HTTP::Get.new(uri)
        request['Authorization'] = "Bearer #{token}"

        response = http.request(request)
        handle_response(response)
      rescue Net::OpenTimeout, Net::ReadTimeout, Errno::ECONNREFUSED, SocketError => e
        @init_error_msg = "Failed to connect to Mergify API: #{e.message}"
      end
      # rubocop:enable Metrics/MethodLength,Metrics/AbcSize

      def handle_response(response)
        case response.code.to_i
        when 200
          data = JSON.parse(response.body)
          @quarantined_tests = data.fetch('quarantined_tests', []).map { |t| t['test_name'] }
        when 402
          # No subscription — silently skip
        else
          @init_error_msg = "Mergify API returned HTTP #{response.code}"
        end
      end
    end
  end
end
