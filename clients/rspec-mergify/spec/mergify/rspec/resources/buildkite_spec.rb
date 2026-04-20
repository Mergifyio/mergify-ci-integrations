# frozen_string_literal: true

require 'spec_helper'
require 'mergify/rspec/resources/buildkite'

RSpec.describe Mergify::RSpec::Resources::Buildkite do
  around do |example|
    original = ENV.to_h
    example.run
    ENV.replace(original)
  end

  before do
    %w[GITHUB_ACTIONS CIRCLECI JENKINS_URL BUILDKITE _RSPEC_MERGIFY_TEST
       BUILDKITE_PIPELINE_NAME BUILDKITE_LABEL BUILDKITE_STEP_KEY
       BUILDKITE_BUILD_ID BUILDKITE_BUILD_URL BUILDKITE_RETRY_COUNT
       BUILDKITE_AGENT_NAME BUILDKITE_BRANCH BUILDKITE_PULL_REQUEST_BASE_BRANCH
       BUILDKITE_COMMIT BUILDKITE_REPO].each { |v| ENV.delete(v) }
  end

  describe '.detect' do
    context 'when not Buildkite' do
      it 'returns an empty resource' do
        resource = described_class.detect
        expect(resource.attribute_enumerator.to_h).to eq({})
      end

      it 'returns empty resource even when GitHub Actions is the CI provider' do
        ENV['GITHUB_ACTIONS'] = 'true'
        resource = described_class.detect
        expect(resource.attribute_enumerator.to_h).to eq({})
      end
    end

    context 'when Buildkite' do
      before do
        ENV['BUILDKITE'] = 'true'
        ENV['BUILDKITE_PIPELINE_NAME'] = 'My Pipeline'
        ENV['BUILDKITE_LABEL'] = 'Run tests'
        ENV['BUILDKITE_BUILD_ID'] = 'abc-123'
        ENV['BUILDKITE_BUILD_URL'] = 'https://buildkite.com/org/pipeline/builds/42'
        ENV['BUILDKITE_RETRY_COUNT'] = '0'
        ENV['BUILDKITE_AGENT_NAME'] = 'agent-1'
        ENV['BUILDKITE_BRANCH'] = 'main'
        ENV['BUILDKITE_PULL_REQUEST_BASE_BRANCH'] = 'main'
        ENV['BUILDKITE_COMMIT'] = 'deadbeef'
        ENV['BUILDKITE_REPO'] = 'https://github.com/owner/repo'

        allow(Mergify::RSpec::Utils).to receive(:git).and_return(nil)
      end

      it 'returns Buildkite attributes' do
        resource = described_class.detect
        attrs = resource.attribute_enumerator.to_h
        expect(attrs['cicd.pipeline.name']).to eq('My Pipeline')
        expect(attrs['cicd.pipeline.task.name']).to eq('Run tests')
        expect(attrs['cicd.pipeline.run.id']).to eq('abc-123')
        expect(attrs['cicd.pipeline.run.url']).to eq('https://buildkite.com/org/pipeline/builds/42')
        expect(attrs['cicd.pipeline.run.attempt']).to eq(0)
        expect(attrs['cicd.pipeline.runner.name']).to eq('agent-1')
        expect(attrs['vcs.ref.head.name']).to eq('main')
        expect(attrs['vcs.ref.base.name']).to eq('main')
        expect(attrs['vcs.ref.head.revision']).to eq('deadbeef')
        expect(attrs['vcs.repository.url.full']).to eq('https://github.com/owner/repo')
        expect(attrs['vcs.repository.name']).to eq('owner/repo')
      end

      it 'casts run attempt to integer' do
        resource = described_class.detect
        attrs = resource.attribute_enumerator.to_h
        expect(attrs['cicd.pipeline.run.attempt']).to be_a(Integer)
      end

      it 'falls back to BUILDKITE_STEP_KEY when BUILDKITE_LABEL is not set' do
        ENV.delete('BUILDKITE_LABEL')
        ENV['BUILDKITE_STEP_KEY'] = 'test-step'
        resource = described_class.detect
        attrs = resource.attribute_enumerator.to_h
        expect(attrs['cicd.pipeline.task.name']).to eq('test-step')
      end

      it 'falls back to BUILDKITE_STEP_KEY when BUILDKITE_LABEL is empty' do
        ENV['BUILDKITE_LABEL'] = ''
        ENV['BUILDKITE_STEP_KEY'] = 'test-step'
        resource = described_class.detect
        attrs = resource.attribute_enumerator.to_h
        expect(attrs['cicd.pipeline.task.name']).to eq('test-step')
      end

      it 'merges git resource attributes first' do
        allow(Mergify::RSpec::Utils).to receive(:git)
          .with('rev-parse', '--abbrev-ref', 'HEAD').and_return('git-branch')
        allow(Mergify::RSpec::Utils).to receive(:git)
          .with('rev-parse', 'HEAD').and_return('git-sha')
        allow(Mergify::RSpec::Utils).to receive(:git)
          .with('config', '--get', 'remote.origin.url').and_return('https://github.com/owner/repo')

        resource = described_class.detect
        attrs = resource.attribute_enumerator.to_h
        # Buildkite-specific values override git values
        expect(attrs['vcs.ref.head.name']).to eq('main')
        expect(attrs['vcs.ref.head.revision']).to eq('deadbeef')
      end
    end
  end
end
