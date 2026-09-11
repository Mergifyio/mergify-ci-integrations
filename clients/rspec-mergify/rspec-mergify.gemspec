# frozen_string_literal: true

require_relative 'lib/mergify/rspec/version'

Gem::Specification.new do |spec|
  spec.name = 'rspec-mergify'
  spec.version = Mergify::RSpec::VERSION
  spec.authors = ['Mergify']
  spec.email = ['support@mergify.com']

  spec.summary = 'RSpec plugin for Mergify CI Insights'
  spec.description = 'RSpec integration for Mergify CI Insights: OpenTelemetry tracing, ' \
                     'flaky test detection, and test quarantine.'
  spec.homepage = 'https://github.com/Mergifyio/mergify-ci-integrations'
  spec.license = 'Apache-2.0'
  spec.required_ruby_version = '>= 3.1'

  spec.metadata['homepage_uri'] = spec.homepage
  # The gem is one client in a monorepo, so point source_code_uri at its
  # subdirectory rather than the repository root, as the npm packages do with
  # their `repository.directory`.
  spec.metadata['source_code_uri'] =
    'https://github.com/Mergifyio/mergify-ci-integrations/tree/main/clients/rspec-mergify'
  spec.metadata['rubygems_mfa_required'] = 'true'

  # LICENSE lives at the monorepo root, not here; the release workflow stages a
  # copy alongside the gem before `gem build` so the published gem still ships it.
  spec.files = Dir['lib/**/*.rb', 'LICENSE', 'README.md']
  spec.require_paths = ['lib']

  spec.add_dependency 'rspec-core', '~> 3.12'
end
