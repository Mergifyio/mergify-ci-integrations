# frozen_string_literal: true

require 'spec_helper'
require 'mergify/rspec/resources/mergify'

RSpec.describe Mergify::RSpec::Resources::Mergify do
  around do |example|
    original = ENV.to_h
    example.run
    ENV.replace(original)
  end

  before do
    ENV.delete('MERGIFY_TEST_JOB_NAME')
  end

  describe '.detect' do
    it 'returns a resource with mergify.test.job.name when env var is set' do
      ENV['MERGIFY_TEST_JOB_NAME'] = 'my-job'
      resource = described_class.detect
      expect(resource.attribute_enumerator.to_h).to eq('mergify.test.job.name' => 'my-job')
    end

    it 'returns an empty resource when MERGIFY_TEST_JOB_NAME is not set' do
      resource = described_class.detect
      expect(resource.attribute_enumerator.to_h).to eq({})
    end
  end
end
