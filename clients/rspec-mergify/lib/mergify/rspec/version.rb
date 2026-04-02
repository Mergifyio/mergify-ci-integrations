# frozen_string_literal: true

module Mergify
  module RSpec
    VERSION = if ENV['GEM_VERSION'] && !ENV['GEM_VERSION'].empty?
                ENV['GEM_VERSION'].delete_prefix('v')
              else
                `git describe --tags --match 'v*' 2>/dev/null`.strip.delete_prefix('v').then do |v|
                  v.empty? ? '0.0.0.dev' : v.tr('-', '.')
                end
              end
  end
end
