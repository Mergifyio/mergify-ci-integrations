# frozen_string_literal: true

require 'spec_helper'
require 'mergify/rspec/resources/ci'

RSpec.describe Mergify::RSpec::Resources::CI do
  around do |example|
    original = ENV.to_h
    example.run
    ENV.replace(original)
  end

  before do
    %w[GITHUB_ACTIONS CIRCLECI JENKINS_URL _RSPEC_MERGIFY_TEST].each { |v| ENV.delete(v) }
  end

  describe '.detect' do
    it 'returns a resource with cicd.provider.name when a CI provider is detected' do
      ENV['GITHUB_ACTIONS'] = 'true'
      resource = described_class.detect
      expect(resource.attribute_enumerator.to_h).to eq('cicd.provider.name' => 'github_actions')
    end

    it 'returns a resource with jenkins provider name' do
      ENV['JENKINS_URL'] = 'http://jenkins.example.com'
      resource = described_class.detect
      expect(resource.attribute_enumerator.to_h).to eq('cicd.provider.name' => 'jenkins')
    end

    it 'returns an empty resource when no CI provider is detected' do
      resource = described_class.detect
      expect(resource.attribute_enumerator.to_h).to eq({})
    end
  end
end
