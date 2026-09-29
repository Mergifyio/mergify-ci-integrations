# frozen_string_literal: true

require 'spec_helper'
require 'mergify/rspec/test_selection'

RSpec.describe Mergify::RSpec::TestSelection do
  let(:ids) { %w[./a_spec.rb[1:1] ./a_spec.rb[1:2] ./b_spec.rb[1:1]] }

  def served(selection, reason: 'queue_rerun', tests: [], message: nil)
    described_class.served('selection' => selection, 'reason' => reason, 'tests' => tests, 'message' => message)
  end

  describe '.enabled?' do
    around do |example|
      original = ENV.fetch(described_class::ENABLE_ENV, nil)
      example.run
    ensure
      ENV[described_class::ENABLE_ENV] = original
    end

    it 'is on for a truthy value, trimmed' do
      ENV[described_class::ENABLE_ENV] = " true\n"
      expect(described_class.enabled?).to be(true)
    end

    it 'is off when unset, empty, or anything it cannot read' do
      [nil, '', 'ture', 'false'].each do |value|
        ENV[described_class::ENABLE_ENV] = value
        expect(described_class.enabled?).to be(false), value.inspect
      end
    end
  end

  describe '#resolve' do
    it 'keeps exactly the served examples of a subset' do
      selection = served('subset', tests: ['./a_spec.rb[1:2]'])

      expect(selection.resolve(ids)).to eq(Set['./a_spec.rb[1:2]'])
      expect([selection.kept_count, selection.deselected_count]).to eq([1, 2])
      expect(selection.not_applied_reason).to be_nil
    end

    it 'runs everything when some served examples were not collected' do
      selection = served('subset', tests: ['./a_spec.rb[1:2]', './gone_spec.rb[1:1]'])

      expect(selection.resolve(ids)).to be_nil
      expect(selection.not_applied_reason).to eq('subset_partly_absent_from_collection')
    end

    it 'runs everything when no served example was collected' do
      selection = served('subset', tests: ['./gone_spec.rb[1:1]'])

      expect(selection.resolve(ids)).to be_nil
      expect(selection.not_applied_reason).to eq('subset_matched_no_collected_test')
    end

    it 'runs everything on a subset naming no example' do
      selection = served('subset', tests: [])

      expect(selection.resolve(ids)).to be_nil
      expect(selection.not_applied_reason).to eq('subset_served_without_tests')
    end

    it 'keeps nothing on an empty answer' do
      selection = served('empty')

      expect(selection.resolve(ids)).to eq(Set.new)
      expect(selection.deselected_count).to eq(3)
    end

    it 'leaves an empty collection alone on an empty answer' do
      selection = served('empty')

      expect(selection.resolve([])).to be_nil
      expect(selection.report).to eq("✂️ Test selection\n")
    end

    it "runs everything on an answer this gem predates, keeping Mergify's word" do
      selection = served('sideways')

      expect(selection.resolve(ids)).to be_nil
      expect([selection.selection, selection.not_applied_reason]).to eq(%w[sideways unrecognised_selection])
    end

    it "raises with the server's explanation on a refusal" do
      expect { served('refused', message: 'Stopped.').resolve(ids) }
        .to raise_error(Mergify::RSpec::TestSelectionRefused, 'Stopped.')
    end

    it 'raises with its own explanation when the server sent none' do
      expect { served('refused').resolve(ids) }
        .to raise_error(Mergify::RSpec::TestSelectionRefused, described_class::FALLBACK_REFUSAL_MESSAGE)
    end

    it 'runs everything when Mergify did not answer' do
      selection = described_class.unanswered(init_error_msg: 'boom')

      expect(selection.resolve(ids)).to be_nil
      expect(selection.served?).to be(false)
    end
  end

  describe '#report' do
    it 'lists the re-executed examples of a subset, and counts past ten' do
      collected = (1..12).map { |i| "./a_spec.rb[1:#{i}]" } + ['./b_spec.rb[1:1]']
      selection = served('subset', tests: collected.first(12))
      selection.resolve(collected)

      expect(selection.report.tr("\n", ' ')).to include('where 12 of its 13 tests failed. Mergify re-executed only')
      expect(selection.report).to include("  ./a_spec.rb[1:10]\n  … and 2 more\n")
    end

    it 'says every collected example was re-executed when nothing was skipped' do
      selection = served('subset', tests: ['./a_spec.rb[1:1]'])
      selection.resolve(['./a_spec.rb[1:1]'])

      expect(selection.report.tr("\n", ' ')).to include('where its only test failed. Mergify re-executed it:')
    end

    it 'says why the full suite ran, without the raw reason' do
      expect(served('full', reason: 'stale_run').report.tr("\n", ' '))
        .to include('The batch branch was updated while this job was running, so the full suite ran.')
      future = served('full', reason: 'a_reason_from_the_future').report
      expect(future).to include('Mergify served the full suite.')
      expect(future).not_to include('a_reason_from_the_future')
    end

    it 'names this gem where the sentence names a client' do
      expect(served('full', reason: 'no_collection_fingerprint').report.tr("\n", ' '))
        .to include("This version of rspec-mergify doesn't report what it collected")
    end

    it 'keeps the error of a failed request on a line of its own' do
      expect(described_class.unanswered(init_error_msg: 'HTTP 500 at https://api.example/x-y').report)
        .to end_with("ran.\nError: HTTP 500 at https://api.example/x-y\n")
    end

    it 'wraps at eighty columns' do
      report = served('full', reason: 'matched_test_session_partially_processed').report

      expect(report.lines.map { |line| line.chomp.length }.max).to be <= 80
    end
  end
end
