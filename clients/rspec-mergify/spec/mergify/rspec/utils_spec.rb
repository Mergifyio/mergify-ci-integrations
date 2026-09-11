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
end
