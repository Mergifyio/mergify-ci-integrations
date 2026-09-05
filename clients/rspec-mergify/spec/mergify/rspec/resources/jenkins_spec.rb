# frozen_string_literal: true

require 'spec_helper'
require 'mergify/rspec/resources/jenkins'

RSpec.describe Mergify::RSpec::Resources::Jenkins do
  around do |example|
    original = ENV.to_h
    example.run
    ENV.replace(original)
  end

  before do
    %w[GITHUB_ACTIONS CIRCLECI JENKINS_URL _RSPEC_MERGIFY_TEST
       JOB_NAME BUILD_ID BUILD_URL NODE_NAME GIT_BRANCH GIT_COMMIT GIT_URL].each { |v| ENV.delete(v) }
  end

  describe '.detect' do
    context 'when not Jenkins' do
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

    context 'when Jenkins' do
      before do
        ENV['JENKINS_URL'] = 'http://jenkins.example.com'
        ENV['JOB_NAME'] = 'my-pipeline'
        ENV['BUILD_ID'] = '42'
        ENV['BUILD_URL'] = 'http://jenkins.example.com/job/my-pipeline/42/'
        ENV['NODE_NAME'] = 'agent-1'
        ENV['GIT_BRANCH'] = 'main'
        ENV['GIT_COMMIT'] = 'abc123'
        ENV['GIT_URL'] = 'https://github.com/owner/repo'

        allow(Mergify::RSpec::Utils).to receive(:git).and_return(nil)
      end

      it 'returns Jenkins attributes' do
        resource = described_class.detect
        attrs = resource.attribute_enumerator.to_h
        expect(attrs['cicd.pipeline.name']).to eq('my-pipeline')
        expect(attrs['cicd.pipeline.task.name']).to eq('my-pipeline')
        expect(attrs['cicd.pipeline.run.id']).to eq('42')
        expect(attrs['cicd.pipeline.run.url']).to eq('http://jenkins.example.com/job/my-pipeline/42/')
        expect(attrs['cicd.pipeline.runner.name']).to eq('agent-1')
        expect(attrs['vcs.ref.head.revision']).to eq('abc123')
        expect(attrs['vcs.repository.url.full']).to eq('https://github.com/owner/repo')
        expect(attrs['vcs.repository.name']).to eq('owner/repo')
      end

      it 'strips origin/ prefix from GIT_BRANCH' do
        ENV['GIT_BRANCH'] = 'origin/feature-branch'
        resource = described_class.detect
        attrs = resource.attribute_enumerator.to_h
        expect(attrs['vcs.ref.head.name']).to eq('feature-branch')
      end

      it 'strips refs/heads/ prefix from GIT_BRANCH' do
        ENV['GIT_BRANCH'] = 'refs/heads/main'
        resource = described_class.detect
        attrs = resource.attribute_enumerator.to_h
        expect(attrs['vcs.ref.head.name']).to eq('main')
      end

      it 'uses GIT_BRANCH as-is when no prefix matches' do
        ENV['GIT_BRANCH'] = 'feature-branch'
        resource = described_class.detect
        attrs = resource.attribute_enumerator.to_h
        expect(attrs['vcs.ref.head.name']).to eq('feature-branch')
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
        # Jenkins-specific values override git values
        expect(attrs['vcs.ref.head.name']).to eq('main')
        expect(attrs['vcs.ref.head.revision']).to eq('abc123')
      end
    end
  end
end
