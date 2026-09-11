# frozen_string_literal: true

module Mergify
  module RSpec
    # Utility methods shared across the rspec-mergify gem.
    #
    # CI detection used to live here -- the provider table, the git shelling
    # out, the per-provider environment mappings. It is the Rust core's now, via
    # the extension in Mergify::RSpec::Native, so that every Mergify test client
    # detects identically. What is left is what is genuinely Ruby's: parsing a
    # repository name the API needs split, and deciding whether the plugin
    # should switch itself on at all.
    module Utils
      module_function

      # Raised when a repository full name (owner/repo) is malformed.
      class InvalidRepositoryFullNameError < StandardError; end

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
      #
      # Deliberately not the core's provider detection: this asks whether the
      # plugin should run, which an unrecognised CI or a developer setting
      # RSPEC_MERGIFY_ENABLE both answer yes to.
      def in_ci?
        env_truthy?('CI') || env_truthy?('RSPEC_MERGIFY_ENABLE')
      end

      # Split "owner/repo" into [owner, repo].
      # Raises InvalidRepositoryFullNameError when the format is wrong.
      def split_full_repo_name(full_repo_name)
        parts = full_repo_name.split('/')
        return parts if parts.size == 2

        raise InvalidRepositoryFullNameError, "Invalid repository name: #{full_repo_name}"
      end
    end
  end
end
