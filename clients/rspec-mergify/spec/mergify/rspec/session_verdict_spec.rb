# frozen_string_literal: true

require 'spec_helper'
require 'mergify/rspec/session_verdict'

RSpec.describe Mergify::RSpec::SessionVerdict do
  subject(:verdict) { described_class.new }

  it 'counts each example once, by its final status' do
    verdict.record('a', 'passed', 0.1)
    verdict.record('b', 'failed', 0.2)
    verdict.record('c', 'skipped', 0.0)
    verdict.record('d', 'quarantined_failed', 0.3)

    expect(verdict.counts).to eq('executed_count' => 4, 'passed_count' => 1, 'failed_count' => 2,
                                 'skipped_count' => 1)
    expect(verdict.failing_tests).to eq(['b'])
    expect(verdict.quarantined_failing_tests).to eq(['d'])
    expect(verdict.total_test_runtime_ms).to eq(600)
  end

  it 'never lets a later record downgrade an earlier one' do
    verdict.record('a', 'failed', 0.0)
    verdict.record('a', 'passed', 0.0)

    expect(verdict.failing_tests).to eq(['a'])
    expect(verdict.counts['executed_count']).to eq(1)
  end

  describe Mergify::RSpec::SessionVerdict::Result do
    it 'says nothing when the verdict landed whole' do
      expect(described_class.new(sent: true, truncated: false).report).to be_nil
    end

    it 'says the next retry runs in full when the verdict failed, with the error' do
      report = described_class.new(sent: false, truncated: false, error: 'HTTP 400').report

      expect(report.tr("\n", ' ')).to include("Mergify couldn't record this run's results. If this merge-queue")
      expect(report).to end_with("\nError: HTTP 400\n")
    end

    it 'says so when only the counts went out' do
      expect(described_class.new(sent: true, truncated: true).report)
        .to include("Mergify recorded this run's counts but not its failing tests.")
    end
  end
end
