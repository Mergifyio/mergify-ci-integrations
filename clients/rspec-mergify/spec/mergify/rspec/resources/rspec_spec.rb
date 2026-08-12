# frozen_string_literal: true

require 'spec_helper'
require 'mergify/rspec/resources/rspec'

RSpec.describe Mergify::RSpec::Resources::RSpec do
  describe '.detect' do
    it 'returns a resource with test.framework set to rspec' do
      resource = described_class.detect
      attrs = resource.attribute_enumerator.to_h
      expect(attrs['test.framework']).to eq('rspec')
    end

    it 'returns a resource with test.framework.version matching RSpec version' do
      resource = described_class.detect
      attrs = resource.attribute_enumerator.to_h
      expect(attrs['test.framework.version']).to eq(RSpec::Core::Version::STRING)
    end

    it 'returns exactly two attributes' do
      resource = described_class.detect
      attrs = resource.attribute_enumerator.to_h
      expect(attrs.keys).to contain_exactly('test.framework', 'test.framework.version')
    end
  end
end
