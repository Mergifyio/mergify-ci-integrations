# frozen_string_literal: true

require 'spec_helper'
require 'mergify/rspec/utils'

RSpec.describe Mergify::RSpec::Utils do
  describe '.strtobool' do
    it 'returns true for truthy strings' do
      %w[y yes t true on 1].each do |val|
        expect(described_class.strtobool(val)).to be(true), "expected '#{val}' to be truthy"
        expect(described_class.strtobool(val.upcase)).to be(true), "expected '#{val.upcase}' to be truthy"
      end
    end

    it 'returns false for falsy strings' do
      %w[n no f false off 0].each do |val|
        expect(described_class.strtobool(val)).to be(false), "expected '#{val}' to be falsy"
        expect(described_class.strtobool(val.upcase)).to be(false), "expected '#{val.upcase}' to be falsy"
      end
    end

    it 'raises ArgumentError for unrecognized strings' do
      expect { described_class.strtobool('maybe') }.to raise_error(ArgumentError, /maybe/)
      expect { described_class.strtobool('') }.to raise_error(ArgumentError)
      expect { described_class.strtobool('2') }.to raise_error(ArgumentError)
    end
  end

  describe '.env_truthy?' do
    around do |example|
      original = ENV.to_h
      example.run
      ENV.replace(original)
    end

    it 'returns true when env var has a truthy value' do
      ENV['TEST_VAR'] = 'true'
      expect(described_class.env_truthy?('TEST_VAR')).to be(true)
    end

    it 'returns true for all truthy values' do
      %w[y yes t true on 1].each do |val|
        ENV['TEST_VAR'] = val
        expect(described_class.env_truthy?('TEST_VAR')).to be(true)
      end
    end

    it 'returns false when env var has a falsy value' do
      ENV['TEST_VAR'] = 'false'
      expect(described_class.env_truthy?('TEST_VAR')).to be(false)
    end

    it 'returns false when env var is not set' do
      ENV.delete('TEST_VAR')
      expect(described_class.env_truthy?('TEST_VAR')).to be(false)
    end

    it 'returns false when env var is empty' do
      ENV['TEST_VAR'] = ''
      expect(described_class.env_truthy?('TEST_VAR')).to be(false)
    end
  end

  describe '.in_ci?' do
    around do |example|
      original = ENV.to_h
      example.run
      ENV.replace(original)
    end

    it 'returns true when CI env var is truthy' do
      ENV.delete('RSPEC_MERGIFY_ENABLE')
      ENV['CI'] = 'true'
      expect(described_class.in_ci?).to be(true)
    end

    it 'returns true when RSPEC_MERGIFY_ENABLE env var is truthy' do
      ENV.delete('CI')
      ENV['RSPEC_MERGIFY_ENABLE'] = 'true'
      expect(described_class.in_ci?).to be(true)
    end

    it 'returns false when neither CI nor RSPEC_MERGIFY_ENABLE is set' do
      ENV.delete('CI')
      ENV.delete('RSPEC_MERGIFY_ENABLE')
      expect(described_class.in_ci?).to be(false)
    end

    it 'returns false when CI is falsy' do
      ENV['CI'] = 'false'
      ENV.delete('RSPEC_MERGIFY_ENABLE')
      expect(described_class.in_ci?).to be(false)
    end
  end

  describe '.ci_provider' do
    around do |example|
      original = ENV.to_h
      example.run
      ENV.replace(original)
    end

    before do
      %w[GITHUB_ACTIONS CIRCLECI JENKINS_URL _RSPEC_MERGIFY_TEST].each do |var|
        ENV.delete(var)
      end
    end

    it 'returns :github_actions when GITHUB_ACTIONS is set' do
      ENV['GITHUB_ACTIONS'] = 'true'
      expect(described_class.ci_provider).to eq(:github_actions)
    end

    it 'returns :circleci when CIRCLECI is set' do
      ENV['CIRCLECI'] = 'true'
      expect(described_class.ci_provider).to eq(:circleci)
    end

    it 'returns :jenkins when JENKINS_URL is set to a URL' do
      ENV['JENKINS_URL'] = 'http://jenkins.example.com'
      expect(described_class.ci_provider).to eq(:jenkins)
    end

    it 'returns :rspec_mergify_suite when _RSPEC_MERGIFY_TEST is set' do
      ENV['_RSPEC_MERGIFY_TEST'] = 'true'
      expect(described_class.ci_provider).to eq(:rspec_mergify_suite)
    end

    it 'returns nil when no CI env var is set' do
      expect(described_class.ci_provider).to be_nil
    end

    it 'returns nil when GITHUB_ACTIONS is falsy' do
      ENV['GITHUB_ACTIONS'] = 'false'
      expect(described_class.ci_provider).to be_nil
    end
  end

  describe '.repository_name_from_url' do
    it 'parses SSH git URLs' do
      expect(described_class.repository_name_from_url('git@github.com:owner/repo.git')).to eq('owner/repo')
      expect(described_class.repository_name_from_url('git@github.com:owner/repo')).to eq('owner/repo')
      expect(described_class.repository_name_from_url('git@gitlab.com:myorg/myrepo.git')).to eq('myorg/myrepo')
    end

    it 'parses HTTPS git URLs' do
      expect(described_class.repository_name_from_url('https://github.com/owner/repo')).to eq('owner/repo')
      expect(described_class.repository_name_from_url('https://github.com/owner/repo.git')).to eq('owner/repo.git')
      expect(described_class.repository_name_from_url('http://github.com/owner/repo')).to eq('owner/repo')
    end

    it 'parses HTTPS URLs with port' do
      expect(described_class.repository_name_from_url('https://github.example.com:8080/owner/repo')).to eq('owner/repo')
    end

    it 'parses bare owner/repo strings' do
      expect(described_class.repository_name_from_url('owner/repo')).to eq('owner/repo')
    end

    it 'returns nil for invalid URLs' do
      expect(described_class.repository_name_from_url('not-a-url')).to be_nil
      expect(described_class.repository_name_from_url('')).to be_nil
    end
  end

  describe '.split_full_repo_name' do
    it 'splits a valid owner/repo string' do
      expect(described_class.split_full_repo_name('owner/repo')).to eq(%w[owner repo])
    end

    it 'raises InvalidRepositoryFullNameError for invalid names' do
      expect do
        described_class.split_full_repo_name('invalid')
      end.to raise_error(Mergify::RSpec::Utils::InvalidRepositoryFullNameError, /invalid/)

      expect do
        described_class.split_full_repo_name('too/many/parts')
      end.to raise_error(Mergify::RSpec::Utils::InvalidRepositoryFullNameError)
    end
  end

  describe '.git' do
    it 'returns output of a successful git command' do
      allow(Open3).to receive(:capture2).and_return(["main\n", double(success?: true)])
      result = described_class.git('rev-parse', '--abbrev-ref', 'HEAD')
      expect(result).to eq('main')
    end

    it 'returns nil when the git command fails' do
      allow(Open3).to receive(:capture2).and_return(['', double(success?: false)])
      result = described_class.git('config', '--get', 'remote.origin.url')
      expect(result).to be_nil
    end

    it 'returns nil when Open3 raises an error' do
      allow(Open3).to receive(:capture2).and_raise(Errno::ENOENT)
      result = described_class.git('status')
      expect(result).to be_nil
    end
  end

  describe '.get_attributes' do
    around do |example|
      original = ENV.to_h
      example.run
      ENV.replace(original)
    end

    it 'returns a hash of attributes from env vars' do
      ENV['MY_STRING'] = 'hello'
      ENV['MY_INT'] = '42'
      mapping = {
        'name' => [:to_s, 'MY_STRING'],
        'count' => [:to_i, 'MY_INT']
      }
      result = described_class.get_attributes(mapping)
      expect(result).to eq('name' => 'hello', 'count' => 42)
    end

    it 'calls callable values instead of reading env vars' do
      callable = -> { 'from_callable' }
      mapping = { 'name' => [:to_s, callable] }
      result = described_class.get_attributes(mapping)
      expect(result).to eq('name' => 'from_callable')
    end

    it 'omits attributes when env var is not set' do
      ENV.delete('MISSING_VAR')
      mapping = { 'name' => [:to_s, 'MISSING_VAR'] }
      result = described_class.get_attributes(mapping)
      expect(result).to eq({})
    end

    it 'omits attributes when callable returns nil' do
      callable = -> {}
      mapping = { 'name' => [:to_s, callable] }
      result = described_class.get_attributes(mapping)
      expect(result).to eq({})
    end
  end

  describe '.repository_name' do
    around do |example|
      original = ENV.to_h
      example.run
      ENV.replace(original)
    end

    before do
      %w[GITHUB_ACTIONS GITHUB_REPOSITORY CIRCLECI CIRCLE_REPOSITORY_URL
         JENKINS_URL GIT_URL _RSPEC_MERGIFY_TEST].each do |var|
        ENV.delete(var)
      end
    end

    it 'returns GITHUB_REPOSITORY when GITHUB_ACTIONS is set' do
      ENV['GITHUB_ACTIONS'] = 'true'
      ENV['GITHUB_REPOSITORY'] = 'owner/repo'
      expect(described_class.repository_name).to eq('owner/repo')
    end

    it 'returns repo name from CIRCLE_REPOSITORY_URL when CIRCLECI is set' do
      ENV['CIRCLECI'] = 'true'
      ENV['CIRCLE_REPOSITORY_URL'] = 'git@github.com:owner/repo.git'
      expect(described_class.repository_name).to eq('owner/repo')
    end

    it 'returns repo name from GIT_URL when JENKINS_URL is set' do
      ENV['JENKINS_URL'] = 'http://jenkins.example.com'
      ENV['GIT_URL'] = 'git@github.com:owner/repo.git'
      expect(described_class.repository_name).to eq('owner/repo')
    end

    it 'returns Mergifyio/rspec-mergify when _RSPEC_MERGIFY_TEST is set' do
      ENV['_RSPEC_MERGIFY_TEST'] = 'true'
      expect(described_class.repository_name).to eq('Mergifyio/rspec-mergify')
    end

    it 'falls back to git remote when no CI is detected' do
      allow(described_class).to receive(:git)
        .with('config', '--get', 'remote.origin.url')
        .and_return('git@github.com:owner/repo.git')
      expect(described_class.repository_name).to eq('owner/repo')
    end

    it 'returns nil when no CI is detected and git remote is unavailable' do
      allow(described_class).to receive(:git)
        .with('config', '--get', 'remote.origin.url')
        .and_return(nil)
      expect(described_class.repository_name).to be_nil
    end
  end
end
