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

      def fetch_quarantined_tests(api_url, token, owner, repo, branch_name)
        uri = URI("#{api_url}/v1/ci/#{owner}/repositories/#{repo}/quarantines")
        uri.query = URI.encode_www_form(branch: branch_name, per_page: 100)
        collected = walk_paginated_quarantines(uri, token)
        @quarantined_tests = collected if collected
      rescue Net::OpenTimeout, Net::ReadTimeout, Errno::ECONNREFUSED, SocketError => e
        @init_error_msg = "Failed to connect to Mergify API: #{e.message}"
      rescue JSON::ParserError => e
        @init_error_msg = "Mergify API returned a malformed quarantine list: #{e.message}"
      end

      # Follows the RFC 5988 `next` link until exhausted. Returns the full list
      # on success, or `nil` when the run was aborted (subscription missing or
      # an error already recorded in @init_error_msg).
      # rubocop:disable Metrics/MethodLength,Metrics/AbcSize
      def walk_paginated_quarantines(uri, token)
        collected = []
        # Guard against a server returning a `next` link that loops back to a
        # URL we have already fetched.
        seen = Set.new
        while uri
          if seen.include?(uri.to_s)
            @init_error_msg = 'Mergify API returned a cyclic `next` link, aborting.'
            return nil
          end
          seen.add(uri.to_s)

          response = perform_request(uri, token)
          case response.code.to_i
          when 200
            data = JSON.parse(response.body)
            collected.concat(data.fetch('quarantined_tests', []).map { |t| t['test_name'] })
            next_url = parse_next_link(response['Link'])
            uri = next_url ? URI(next_url) : nil
          when 402
            return nil
          else
            @init_error_msg = "Mergify API returned HTTP #{response.code}"
            return nil
          end
        end
        collected
      end
      # rubocop:enable Metrics/MethodLength,Metrics/AbcSize

      def perform_request(uri, token)
        http = Net::HTTP.new(uri.host, uri.port)
        http.use_ssl = uri.scheme == 'https'
        http.open_timeout = 10
        http.read_timeout = 10

        request = Net::HTTP::Get.new(uri)
        request['Authorization'] = "Bearer #{token}"
        http.request(request)
      end

      # Parses RFC 8288 Link headers tolerantly: accepts both quoted
      # (`rel="next"`) and token (`rel=next`) forms, and matches when `next`
      # is one of several space-separated rel-types (`rel="next prev"`).
      def parse_next_link(link_header)
        return nil if link_header.nil? || link_header.empty?

        link_header.split(',').each do |part|
          match = part.strip.match(/\A<([^>]+)>\s*;\s*(.+)\z/)
          next unless match && next_rel?(match[2])

          return match[1]
        end
        nil
      end

      def next_rel?(params)
        params.scan(/rel\s*=\s*(?:"([^"]+)"|([^\s;,]+))/i).any? do |quoted, token|
          (quoted || token).split.include?('next')
        end
      end
    end
  end
end
