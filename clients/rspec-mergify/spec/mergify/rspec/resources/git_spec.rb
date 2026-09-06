# frozen_string_literal: true

require 'spec_helper'
require 'mergify/rspec/resources/git'

RSpec.describe Mergify::RSpec::Resources::Git do
  around do |example|
    original = ENV.to_h
    example.run
    ENV.replace(original)
  end

  before do
    %w[GITHUB_ACTIONS CIRCLECI JENKINS_URL _RSPEC_MERGIFY_TEST].each { |v| ENV.delete(v) }
  end

  describe '.detect' do
    context 'when not in CI' do
      it 'returns an empty resource' do
        resource = described_class.detect
        expect(resource.attribute_enumerator.to_h).to eq({})
      end
    end

    context 'when in CI' do
      before do
        ENV['_RSPEC_MERGIFY_TEST'] = 'true'
        allow(Mergify::RSpec::Utils).to receive(:git)
          .with('rev-parse', '--abbrev-ref', 'HEAD').and_return('main')
        allow(Mergify::RSpec::Utils).to receive(:git)
          .with('rev-parse', 'HEAD').and_return('abc123')
        allow(Mergify::RSpec::Utils).to receive(:git)
          .with('config', '--get', 'remote.origin.url').and_return('https://github.com/owner/repo')
      end

      it 'returns git attributes' do
        resource = described_class.detect
        attrs = resource.attribute_enumerator.to_h
        expect(attrs['vcs.ref.head.name']).to eq('main')
        expect(attrs['vcs.ref.head.revision']).to eq('abc123')
        expect(attrs['vcs.repository.url.full']).to eq('https://github.com/owner/repo')
        expect(attrs['vcs.repository.name']).to eq('owner/repo')
      end

      it 'omits attributes when git commands return nil' do
        allow(Mergify::RSpec::Utils).to receive(:git)
          .with('rev-parse', '--abbrev-ref', 'HEAD').and_return(nil)
        allow(Mergify::RSpec::Utils).to receive(:git)
          .with('rev-parse', 'HEAD').and_return(nil)
        allow(Mergify::RSpec::Utils).to receive(:git)
          .with('config', '--get', 'remote.origin.url').and_return(nil)

        resource = described_class.detect
        attrs = resource.attribute_enumerator.to_h
        expect(attrs).not_to have_key('vcs.ref.head.name')
        expect(attrs).not_to have_key('vcs.ref.head.revision')
        expect(attrs).not_to have_key('vcs.repository.url.full')
        expect(attrs).not_to have_key('vcs.repository.name')
      end
    end
  end
end
