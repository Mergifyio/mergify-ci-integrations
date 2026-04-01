# frozen_string_literal: true

require_relative 'rspec/version'

module Mergify
  module RSpec
    class << self
      attr_accessor :ci_insights
    end
  end
end
