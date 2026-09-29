# frozen_string_literal: true

require 'spec_helper'
require 'open3'
require 'tmpdir'

RSpec.describe Mergify::RSpec::Configuration do
  describe '.setup!' do
    it 'does not raise' do
      expect { described_class.setup! }.not_to raise_error
    end
  end

  describe '.select_examples' do
    it 'reports a failure of its own and lets the whole suite run' do
      insights = instance_double(Mergify::RSpec::CIInsights)
      allow(insights).to receive(:on_examples_collected).and_raise(RuntimeError, 'boom')
      allow(Mergify::RSpec).to receive(:ci_insights).and_return(insights)
      error_stream = StringIO.new
      allow(RSpec.configuration).to receive(:error_stream).and_return(error_stream)

      expect { described_class.select_examples }.not_to raise_error
      expect(error_stream.string)
        .to eq("Mergify Test Selection failed, so the full suite runs: RuntimeError: boom\n")
    end
  end

  # RSpec only adds its default formatter when no other was added, and it
  # decides that only when the run starts. So this has to be a real run: in
  # this process the suite has long started.
  describe 'running a suite in CI' do
    def run_rspec(*args)
      Dir.mktmpdir do |dir|
        File.write(File.join(dir, 'probe_spec.rb'), "RSpec.describe('probe') { it('runs') {} }\n")
        env = { 'CI' => 'true', 'MERGIFY_TOKEN' => nil, '_RSPEC_MERGIFY_TEST' => nil, 'RSPEC_MERGIFY_DEBUG' => nil }
        command = [RbConfig.ruby, '-I', File.expand_path('../../../lib', __dir__),
                   Gem.bin_path('rspec-core', 'rspec'), '--require', 'rspec_mergify', *args, 'probe_spec.rb']
        Open3.capture2e(env, *command, chdir: dir).first
      end
    end

    it 'keeps the default formatter when the suite chose none' do
      output = run_rspec

      expect(output).to include('--- Mergify CI ---')
      expect(output).to include('1 example, 0 failures')
    end

    it 'adds no default formatter next to the one the suite chose' do
      output = run_rspec('--format', 'documentation')

      expect(output).to include('--- Mergify CI ---')
      expect(output).to match(/^probe\n  runs$/)
      expect(output.scan('1 example, 0 failures').size).to eq(1)
    end
  end
end
