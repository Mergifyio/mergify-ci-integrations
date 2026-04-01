# frozen_string_literal: true

require_relative "lib/mergify/rspec/version"

Gem::Specification.new do |spec|
  spec.name = "rspec-mergify"
  spec.version = Mergify::RSpec::VERSION
  spec.authors = ["Mergify"]
  spec.email = ["support@mergify.com"]

  spec.summary = "RSpec plugin for Mergify CI Insights"
  spec.description = "RSpec integration for Mergify CI Insights: OpenTelemetry tracing, flaky test detection, and test quarantine."
  spec.homepage = "https://github.com/Mergifyio/rspec-mergify"
  spec.license = "GPL-3.0-only"
  spec.required_ruby_version = ">= 3.1"

  spec.metadata["homepage_uri"] = spec.homepage
  spec.metadata["source_code_uri"] = spec.homepage

  spec.files = Dir["lib/**/*.rb", "LICENSE", "README.md"]
  spec.require_paths = ["lib"]

  spec.add_dependency "rspec-core", "~> 3.12"
  spec.add_dependency "opentelemetry-sdk", "~> 1.4"
  spec.add_dependency "opentelemetry-exporter-otlp", "~> 0.29"
end
