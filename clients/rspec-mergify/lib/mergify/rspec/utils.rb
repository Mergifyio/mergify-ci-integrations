# frozen_string_literal: true

require 'open3'

module Mergify
  module RSpec
    # Utility methods shared across the rspec-mergify gem.
    module Utils
      module_function

      # Raised when a repository full name (owner/repo) is malformed.
      class InvalidRepositoryFullNameError < StandardError; end

      SUPPORTED_CIS = {
        'GITHUB_ACTIONS' => :github_actions,
        'CIRCLECI' => :circleci,
        'JENKINS_URL' => :jenkins,
        '_RSPEC_MERGIFY_TEST' => :rspec_mergify_suite
      }.freeze

      TRUTHY_STRINGS = %w[y yes t true on 1].freeze
      FALSY_STRINGS  = %w[n no f false off 0].freeze

      # Convert a string to a boolean.
      # Truthy: y yes t true on 1
      # Falsy:  n no f false off 0
      # Raises ArgumentError for anything else.
      def strtobool(string)
        return true  if TRUTHY_STRINGS.include?(string.downcase)
        return false if FALSY_STRINGS.include?(string.downcase)

        raise ArgumentError, "Could not convert '#{string}' to boolean"
      end

      # Returns true when the named environment variable holds a truthy value.
      def env_truthy?(key)
        TRUTHY_STRINGS.include?(ENV.fetch(key, '').downcase)
      end

      # Returns true when the suite is running inside CI or when
      # RSPEC_MERGIFY_ENABLE is set to a truthy value.
      def in_ci?
        env_truthy?('CI') || env_truthy?('RSPEC_MERGIFY_ENABLE')
      end

      # Evaluates whether a CI environment variable should be considered enabled.
      # rubocop:disable Metrics/MethodLength
      def ci_provider
        SUPPORTED_CIS.each do |envvar, name|
          next unless ENV.key?(envvar)

          enabled =
            begin
              strtobool(ENV.fetch(envvar, ''))
            rescue ArgumentError
              !ENV.fetch(envvar, '').strip.empty?
            end

          return name if enabled
        end
        nil
      end
      # rubocop:enable Metrics/MethodLength

      # Parse a git remote URL (SSH or HTTPS) into "owner/repo" form.
      # Returns nil when the URL cannot be recognised.
      def repository_name_from_url(url)
        # SSH: git@github.com:owner/repo.git
        if (m = url.match(%r{\Agit@[\w.-]+:(?<full_name>[\w.-]+/[\w.-]+?)(?:\.git)?/?$}))
          return m[:full_name]
        end

        # HTTPS/HTTP with optional host (and optional port)
        if (m = url.match(%r{\A(?:https?://[\w.-]+(?::\d+)?/)?(?<full_name>[\w.-]+/[\w.-]+)/?\z}))
          return m[:full_name]
        end

        nil
      end

      # Split "owner/repo" into [owner, repo].
      # Raises InvalidRepositoryFullNameError when the format is wrong.
      def split_full_repo_name(full_repo_name)
        parts = full_repo_name.split('/')
        return parts if parts.size == 2

        raise InvalidRepositoryFullNameError, "Invalid repository name: #{full_repo_name}"
      end

      # Run a git subcommand via Open3.
      # Returns stripped stdout on success, nil on failure.
      def git(*args)
        stdout, status = Open3.capture2('git', *args, err: File::NULL)
        status.success? ? stdout.strip : nil
      rescue StandardError
        nil
      end

      # Build an attribute hash from a mapping of
      # { attr_name => [cast_method_symbol, env_var_name_or_callable] }.
      # Attributes whose env var is unset or whose callable returns nil are omitted.
      def get_attributes(mapping)
        mapping.each_with_object({}) do |(attr, (cast, env_or_callable)), result|
          value =
            if env_or_callable.respond_to?(:call)
              env_or_callable.call
            else
              ENV.fetch(env_or_callable, nil)
            end

          result[attr] = value.public_send(cast) unless value.nil?
        end
      end

      # Detect the repository name using CI environment variables or a git
      # remote fallback.
      # rubocop:disable Metrics/MethodLength,Metrics/CyclomaticComplexity
      def repository_name
        provider = ci_provider

        case provider
        when :jenkins
          url = ENV.fetch('GIT_URL', nil)
          return repository_name_from_url(url) if url
        when :github_actions
          return ENV.fetch('GITHUB_REPOSITORY', nil)
        when :circleci
          url = ENV.fetch('CIRCLE_REPOSITORY_URL', nil)
          return repository_name_from_url(url) if url
        when :rspec_mergify_suite
          return 'Mergifyio/rspec-mergify'
        end

        url = git('config', '--get', 'remote.origin.url')
        repository_name_from_url(url) if url
      end
      # rubocop:enable Metrics/MethodLength,Metrics/CyclomaticComplexity
    end
  end
end
