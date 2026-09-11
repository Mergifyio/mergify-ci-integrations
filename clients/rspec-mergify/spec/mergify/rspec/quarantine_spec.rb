# frozen_string_literal: true

require 'spec_helper'
require 'mergify/rspec/quarantine'
require 'mergify/rspec/native'

# The class now talks to the binding, so these need it compiled -- `rake spec`
# builds it first, which is what CI runs. A bare `rspec` on a checkout without
# the extension skips them rather than failing, as the binding's own specs do.
# The no-extension path is still covered here, by stubbing `available?` false.
RSpec.describe Mergify::RSpec::Quarantine, if: Mergify::RSpec::Native.available? do
  let(:api_url) { 'https://api.mergify.com' }
  let(:token) { 'test-token' }
  let(:repo_name) { 'owner/repo' }
  let(:branch_name) { 'main' }
  let(:tests) { ['./spec/foo_spec.rb[1:1]', './spec/bar_spec.rb[1:2]'] }

  # The fetch happens in Rust, where WebMock cannot see it, so the seam is the
  # client object rather than the HTTP call. A verifying double keeps that
  # honest: it fails if the binding's signature ever drifts from what this
  # class calls. Everything the old stubs covered -- pagination, `next` links,
  # malformed bodies, timeouts -- is the Rust client's contract now, tested
  # there and pinned from Ruby in the binding's own specs.
  let(:client) { instance_double(Mergify::RSpec::Native::Client) }

  def build(fetch: nil, raises: nil)
    allow(Mergify::RSpec::Native).to receive(:available?).and_return(true)
    allow(Mergify::RSpec::Native::Client).to receive(:new).and_return(client)
    if raises
      allow(client).to receive(:fetch_quarantine).and_raise(raises)
    else
      allow(client).to receive(:fetch_quarantine).and_return(fetch)
    end
    described_class.new(api_url: api_url, token: token, repo_name: repo_name, branch_name: branch_name)
  end

  describe '#initialize' do
    it 'populates quarantined_tests with the names the client returned' do
      expect(build(fetch: tests).quarantined_tests).to eq(tests)
    end

    it 'records no error on success' do
      expect(build(fetch: tests).init_error_msg).to be_nil
    end

    it 'asks for the branch it was given' do
      allow(Mergify::RSpec::Native).to receive(:available?).and_return(true)
      allow(Mergify::RSpec::Native::Client).to receive(:new).and_return(client)
      allow(client).to receive(:fetch_quarantine).and_return([])

      described_class.new(api_url: api_url, token: token, repo_name: repo_name, branch_name: branch_name)

      expect(client).to have_received(:fetch_quarantine).with(branch_name)
    end

    context 'when the repository has no quarantine subscription' do
      it 'quarantines nothing, and calls it no error' do
        quarantine = build(fetch: nil)

        expect(quarantine.quarantined_tests).to eq([])
        expect(quarantine.init_error_msg).to be_nil
      end
    end

    context 'when the API call fails' do
      it 'records the message instead of failing the suite' do
        quarantine = build(raises: Mergify::RSpec::Native::ApiError.new('Mergify API returned HTTP 500'))

        expect(quarantine.init_error_msg).to eq('Mergify API returned HTTP 500')
        expect(quarantine.quarantined_tests).to eq([])
      end
    end

    context 'with an invalid repo_name' do
      let(:repo_name) { 'not-a-full-name' }

      it 'records the message without building a client' do
        allow(Mergify::RSpec::Native).to receive(:available?).and_return(true)
        allow(Mergify::RSpec::Native::Client).to receive(:new)

        quarantine = described_class.new(api_url: api_url, token: token, repo_name: repo_name,
                                         branch_name: branch_name)

        expect(quarantine.init_error_msg).to include('Invalid repository name')
        expect(Mergify::RSpec::Native::Client).not_to have_received(:new)
      end
    end

    context 'without the native extension' do
      it 'says so, and quarantines nothing' do
        allow(Mergify::RSpec::Native).to receive_messages(available?: false,
                                                          load_error: LoadError.new('no such file'))

        quarantine = described_class.new(api_url: api_url, token: token, repo_name: repo_name,
                                         branch_name: branch_name)

        expect(quarantine.init_error_msg).to include('native extension unavailable')
        expect(quarantine.quarantined_tests).to eq([])
      end
    end
  end

  describe '#include?' do
    subject(:quarantine) { build(fetch: tests) }

    it 'returns true for a quarantined test' do
      expect(quarantine.include?('./spec/foo_spec.rb[1:1]')).to be(true)
    end

    it 'returns false for a non-quarantined test' do
      expect(quarantine.include?('./spec/other_spec.rb[1:1]')).to be(false)
    end
  end

  describe '#mark_as_used' do
    it 'tracks the example as used' do
      quarantine = build(fetch: tests)
      quarantine.mark_as_used('./spec/foo_spec.rb[1:1]')

      expect(quarantine.report).to include('Quarantined tests run (1)')
    end
  end

  describe '#report' do
    subject(:report) do
      quarantine = build(fetch: tests)
      quarantine.mark_as_used('./spec/foo_spec.rb[1:1]')
      quarantine.report
    end

    it 'includes the repository name' do
      expect(report).to include('owner/repo')
    end

    it 'includes the branch name' do
      expect(report).to include('main')
    end

    it 'includes the count of quarantined tests' do
      expect(report).to include('Quarantined tests from API: 2')
    end

    it 'lists used quarantined tests' do
      expect(report).to match(%r{Quarantined tests run \(1\):\n\s+- \./spec/foo_spec\.rb\[1:1\]})
    end

    it 'lists unused quarantined tests' do
      expect(report).to match(%r{Unused quarantined tests \(1\):\n\s+- \./spec/bar_spec\.rb\[1:2\]})
    end
  end
end
