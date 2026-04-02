# frozen_string_literal: true

require 'spec_helper'
require 'mergify/rspec/quarantine'

RSpec.describe Mergify::RSpec::Quarantine do
  let(:api_url) { 'https://api.mergify.com' }
  let(:token) { 'test-token' }
  let(:repo_name) { 'owner/repo' }
  let(:branch_name) { 'main' }

  let(:quarantine_url) { 'https://api.mergify.com/v1/ci/owner/repositories/repo/quarantines' }

  let(:quarantined_tests_response) do
    {
      quarantined_tests: [
        { test_name: './spec/foo_spec.rb[1:1]' },
        { test_name: './spec/bar_spec.rb[1:2]' }
      ]
    }.to_json
  end

  def stub_quarantine_request(status: 200, body: quarantined_tests_response)
    stub_request(:get, quarantine_url)
      .with(
        query: { branch: branch_name },
        headers: { 'Authorization' => "Bearer #{token}" }
      )
      .to_return(
        status: status,
        body: body,
        headers: { 'Content-Type' => 'application/json' }
      )
  end

  describe '#initialize' do
    context 'with successful fetch' do
      before { stub_quarantine_request }

      it 'populates quarantined_tests with test names' do
        q = described_class.new(api_url: api_url, token: token, repo_name: repo_name, branch_name: branch_name)
        expect(q.quarantined_tests).to contain_exactly('./spec/foo_spec.rb[1:1]', './spec/bar_spec.rb[1:2]')
      end

      it 'sets init_error_msg to nil' do
        q = described_class.new(api_url: api_url, token: token, repo_name: repo_name, branch_name: branch_name)
        expect(q.init_error_msg).to be_nil
      end
    end

    context 'with HTTP 402 response' do
      before { stub_quarantine_request(status: 402, body: '') }

      it 'leaves quarantined_tests empty' do
        q = described_class.new(api_url: api_url, token: token, repo_name: repo_name, branch_name: branch_name)
        expect(q.quarantined_tests).to be_empty
      end

      it 'does not set init_error_msg' do
        q = described_class.new(api_url: api_url, token: token, repo_name: repo_name, branch_name: branch_name)
        expect(q.init_error_msg).to be_nil
      end
    end

    context 'with HTTP 500 response' do
      before { stub_quarantine_request(status: 500, body: 'Internal Server Error') }

      it 'sets init_error_msg' do
        q = described_class.new(api_url: api_url, token: token, repo_name: repo_name, branch_name: branch_name)
        expect(q.init_error_msg).not_to be_nil
      end

      it 'leaves quarantined_tests empty' do
        q = described_class.new(api_url: api_url, token: token, repo_name: repo_name, branch_name: branch_name)
        expect(q.quarantined_tests).to be_empty
      end
    end

    context 'with connection timeout' do
      before do
        stub_request(:get, quarantine_url)
          .with(query: { branch: branch_name })
          .to_timeout
      end

      it 'sets init_error_msg' do
        q = described_class.new(api_url: api_url, token: token, repo_name: repo_name, branch_name: branch_name)
        expect(q.init_error_msg).not_to be_nil
      end

      it 'leaves quarantined_tests empty' do
        q = described_class.new(api_url: api_url, token: token, repo_name: repo_name, branch_name: branch_name)
        expect(q.quarantined_tests).to be_empty
      end
    end

    context 'with invalid repo_name format' do
      it 'sets init_error_msg without making any HTTP request' do
        q = described_class.new(api_url: api_url, token: token, repo_name: 'invalid-repo', branch_name: branch_name)
        expect(q.init_error_msg).not_to be_nil
      end

      it 'leaves quarantined_tests empty' do
        q = described_class.new(api_url: api_url, token: token, repo_name: 'invalid-repo', branch_name: branch_name)
        expect(q.quarantined_tests).to be_empty
      end
    end
  end

  describe '#include?' do
    before { stub_quarantine_request }

    let(:quarantine) do
      described_class.new(api_url: api_url, token: token, repo_name: repo_name, branch_name: branch_name)
    end

    it 'returns true for a quarantined test' do
      expect(quarantine.include?('./spec/foo_spec.rb[1:1]')).to be(true)
    end

    it 'returns false for a non-quarantined test' do
      expect(quarantine.include?('./spec/unknown_spec.rb[1:1]')).to be(false)
    end
  end

  describe '#mark_as_used' do
    before { stub_quarantine_request }

    let(:quarantine) do
      described_class.new(api_url: api_url, token: token, repo_name: repo_name, branch_name: branch_name)
    end

    it 'tracks the example as used' do
      quarantine.mark_as_used('./spec/foo_spec.rb[1:1]')
      used = quarantine.instance_variable_get(:@used_tests)
      expect(used).to include('./spec/foo_spec.rb[1:1]')
    end
  end

  describe '#report' do
    let(:quarantine) do
      described_class.new(api_url: api_url, token: token, repo_name: repo_name, branch_name: branch_name)
    end

    before do
      stub_quarantine_request
      quarantine.mark_as_used('./spec/foo_spec.rb[1:1]')
    end

    it 'includes the repository name' do
      expect(quarantine.report).to include('owner/repo')
    end

    it 'includes the branch name' do
      expect(quarantine.report).to include('main')
    end

    it 'includes the count of quarantined tests' do
      expect(quarantine.report).to include('2')
    end

    it 'lists used quarantined tests' do
      expect(quarantine.report).to include('./spec/foo_spec.rb[1:1]')
    end

    it 'lists unused quarantined tests' do
      expect(quarantine.report).to include('./spec/bar_spec.rb[1:2]')
    end
  end
end
