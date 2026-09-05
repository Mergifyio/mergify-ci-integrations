# frozen_string_literal: true

require 'spec_helper'

RSpec.describe Mergify::RSpec::Configuration do
  describe '.setup!' do
    it 'does not raise' do
      expect { described_class.setup! }.not_to raise_error
    end
  end
end
