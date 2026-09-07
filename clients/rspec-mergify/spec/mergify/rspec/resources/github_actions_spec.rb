# frozen_string_literal: true

require 'spec_helper'
require 'tempfile'
require 'mergify/rspec/resources/github_actions'

RSpec.describe Mergify::RSpec::Resources::GitHubActions do
  around do |example|
    original = ENV.to_h
    example.run
    ENV.replace(original)
  end

  before do
    %w[GITHUB_ACTIONS CIRCLECI JENKINS_URL _RSPEC_MERGIFY_TEST
       GITHUB_WORKFLOW GITHUB_JOB GITHUB_RUN_ID GITHUB_RUN_ATTEMPT
       RUNNER_NAME GITHUB_HEAD_REF GITHUB_REF_NAME GITHUB_REF_TYPE
       GITHUB_BASE_REF GITHUB_REPOSITORY GITHUB_REPOSITORY_ID
       GITHUB_SERVER_URL GITHUB_SHA GITHUB_EVENT_NAME GITHUB_EVENT_PATH].each { |v| ENV.delete(v) }
  end

  describe '.detect' do
    context 'when not GitHub Actions' do
      it 'returns an empty resource' do
        resource = described_class.detect
        expect(resource.attribute_enumerator.to_h).to eq({})
      end

      it 'returns empty resource even when Jenkins is the CI provider' do
        ENV['JENKINS_URL'] = 'http://jenkins.example.com'
        resource = described_class.detect
        expect(resource.attribute_enumerator.to_h).to eq({})
      end
    end

    context 'when GitHub Actions' do
      before do
        ENV['GITHUB_ACTIONS'] = 'true'
        ENV['GITHUB_WORKFLOW'] = 'CI'
        ENV['GITHUB_JOB'] = 'test'
        ENV['GITHUB_RUN_ID'] = '123456'
        ENV['GITHUB_RUN_ATTEMPT'] = '1'
        ENV['RUNNER_NAME'] = 'ubuntu-runner'
        ENV['GITHUB_REF_NAME'] = 'main'
        ENV['GITHUB_REF_TYPE'] = 'branch'
        ENV['GITHUB_REPOSITORY'] = 'owner/repo'
        ENV['GITHUB_REPOSITORY_ID'] = '789'
        ENV['GITHUB_SERVER_URL'] = 'https://github.com'
        ENV['GITHUB_SHA'] = 'deadbeef'
      end

      it 'returns GHA attributes' do
        resource = described_class.detect
        attrs = resource.attribute_enumerator.to_h
        expect(attrs['cicd.pipeline.name']).to eq('CI')
        expect(attrs['cicd.pipeline.task.name']).to eq('test')
        expect(attrs['cicd.pipeline.run.id']).to eq(123_456)
        expect(attrs['cicd.pipeline.run.attempt']).to eq(1)
        expect(attrs['cicd.pipeline.runner.name']).to eq('ubuntu-runner')
        expect(attrs['vcs.ref.head.name']).to eq('main')
        expect(attrs['vcs.ref.head.type']).to eq('branch')
        expect(attrs['vcs.repository.name']).to eq('owner/repo')
        expect(attrs['vcs.repository.id']).to eq(789)
        expect(attrs['vcs.repository.url.full']).to eq('https://github.com/owner/repo')
        expect(attrs['vcs.ref.head.revision']).to eq('deadbeef')
      end

      it 'casts run id, run attempt, and repository id to integers' do
        resource = described_class.detect
        attrs = resource.attribute_enumerator.to_h
        expect(attrs['cicd.pipeline.run.id']).to be_a(Integer)
        expect(attrs['cicd.pipeline.run.attempt']).to be_a(Integer)
        expect(attrs['vcs.repository.id']).to be_a(Integer)
      end

      it 'uses GITHUB_HEAD_REF over GITHUB_REF_NAME when set and non-empty' do
        ENV['GITHUB_HEAD_REF'] = 'feature-branch'
        resource = described_class.detect
        attrs = resource.attribute_enumerator.to_h
        expect(attrs['vcs.ref.head.name']).to eq('feature-branch')
      end

      it 'falls back to GITHUB_REF_NAME when GITHUB_HEAD_REF is empty' do
        ENV['GITHUB_HEAD_REF'] = ''
        ENV['GITHUB_REF_NAME'] = 'main'
        resource = described_class.detect
        attrs = resource.attribute_enumerator.to_h
        expect(attrs['vcs.ref.head.name']).to eq('main')
      end

      it 'reads head sha from event file for pull_request events' do
        ENV['GITHUB_EVENT_NAME'] = 'pull_request'
        event_file = Tempfile.new(['event', '.json'])
        event_file.write(JSON.generate({ 'pull_request' => { 'head' => { 'sha' => 'pr-head-sha' } } }))
        event_file.close
        ENV['GITHUB_EVENT_PATH'] = event_file.path

        resource = described_class.detect
        attrs = resource.attribute_enumerator.to_h
        expect(attrs['vcs.ref.head.revision']).to eq('pr-head-sha')
      ensure
        event_file&.unlink
      end

      it 'uses GITHUB_SHA when not a pull_request event' do
        ENV['GITHUB_EVENT_NAME'] = 'push'
        resource = described_class.detect
        attrs = resource.attribute_enumerator.to_h
        expect(attrs['vcs.ref.head.revision']).to eq('deadbeef')
      end

      it 'includes vcs.ref.base.name when GITHUB_BASE_REF is set' do
        ENV['GITHUB_BASE_REF'] = 'main'
        resource = described_class.detect
        attrs = resource.attribute_enumerator.to_h
        expect(attrs['vcs.ref.base.name']).to eq('main')
      end
    end
  end
end
