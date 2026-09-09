# frozen_string_literal: true

require 'set'
require_relative 'utils'
require_relative 'native'
require_relative 'version'

module Mergify
  module RSpec
    # Fetches quarantined test names from the Mergify API and tracks which are used.
    #
    # The fetch itself -- pagination, the RFC 8288 `next` links, the status
    # codes that mean "not subscribed" rather than "broken" -- belongs to the
    # shared Rust client now, so every Mergify test client reads a quarantine
    # list the same way. What stays here is what RSpec cares about: which of
    # those tests this session actually ran, and the report at the end.
    class Quarantine
      attr_reader :quarantined_tests, :init_error_msg

      def initialize(api_url:, token:, repo_name:, branch_name:)
        @repo_name = repo_name
        @branch_name = branch_name
        @quarantined_tests = []
        @used_tests = Set.new
        @init_error_msg = nil

        fetch(api_url, token, branch_name)
      end

      def include?(example_id)
        @quarantined_tests.include?(example_id)
      end

      def mark_as_used(example_id)
        @used_tests.add(example_id)
      end

      # rubocop:disable-next Metrics/MethodLength,Metrics/AbcSize
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

      private

      # A nil list means the repository has no quarantine subscription, which is
      # not an error: the session simply quarantines nothing. Anything that went
      # genuinely wrong is recorded and the suite carries on -- this plugin has
      # never let the backend fail a test run.
      def fetch(api_url, token, branch_name)
        unless Native.available?
          @init_error_msg = "Mergify native extension unavailable: #{Native.load_error}"
          return
        end

        owner, repo = Utils.split_full_repo_name(@repo_name)
        client = Native::Client.new(api_url, token, owner, repo, VERSION)
        @quarantined_tests = client.fetch_quarantine(branch_name) || []
      rescue Utils::InvalidRepositoryFullNameError, Native::ApiError => e
        @init_error_msg = e.message
      end
    end
  end
end
