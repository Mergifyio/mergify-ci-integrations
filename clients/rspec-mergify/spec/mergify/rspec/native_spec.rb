# frozen_string_literal: true

require 'spec_helper'
require 'mergify/rspec/native'
require 'mergify/rspec/utils'

RSpec.describe Mergify::RSpec::Native do
  around do |example|
    original = ENV.to_h
    example.run
  ensure
    ENV.replace(original)
  end

  describe 'loading' do
    it 'reports its status instead of raising when the extension is absent' do
      expect(described_class).to respond_to(:available?)
      expect(described_class).to respond_to(:load_error)
    end

    it 'records a LoadError, or nothing at all' do
      expect(described_class.load_error).to be_nil.or be_a(LoadError)
      expect(described_class.available?).to be(described_class.load_error.nil?)
    end
  end

  # `rake compile` builds the extension; a bare `bundle exec rspec` on a
  # checkout without it still runs the rest of the suite, so skip rather than
  # fail -- the CI job compiles first, and that is where this is a real gate.
  describe 'detection', if: described_class.available? do
    before { %w[GITHUB_ACTIONS CIRCLECI JENKINS_URL BUILDKITE _RSPEC_MERGIFY_TEST].each { |v| ENV.delete(v) } }

    it "identifies the gem's own suite" do
      ENV['_RSPEC_MERGIFY_TEST'] = 'true'

      expect(described_class.detect_provider).to eq('rspec_mergify_suite')
      expect(described_class.detect_repository_name).to eq('Mergifyio/rspec-mergify')
    end

    it 'agrees with the Ruby detection it replaces' do
      {
        { '_RSPEC_MERGIFY_TEST' => 'true' } => :rspec_mergify_suite,
        { 'GITHUB_ACTIONS' => 'true', 'GITHUB_REPOSITORY' => 'Mergifyio/x' } => :github_actions,
        { 'BUILDKITE' => 'true', 'BUILDKITE_REPO' => 'git@github.com:Mergifyio/x.git' } => :buildkite
      }.each do |env, expected|
        ENV.replace(ENV.to_h.merge(env))

        expect(described_class.detect_provider).to eq(expected.to_s)
        expect(described_class.detect_provider).to eq(Mergify::RSpec::Utils.ci_provider.to_s)
        expect(described_class.detect_repository_name).to eq(Mergify::RSpec::Utils.repository_name)

        env.each_key { |k| ENV.delete(k) }
      end
    end

    it 'returns nothing outside CI' do
      expect(described_class.detect_provider).to be_nil
    end

    it 'returns attributes keyed by semconv name' do
      ENV['_RSPEC_MERGIFY_TEST'] = 'true'
      attributes = described_class.detect_attributes

      expect(attributes).to be_a(Hash)
      expect(attributes.keys).to all(be_a(String))
      expect(attributes.values).to all(be_a(String).or(be_a(Integer)))
    end
  end
end
