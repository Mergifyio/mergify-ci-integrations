# frozen_string_literal: true

module Mergify
  module RSpec
    VERSION = `git describe --tags --match '*' 2>/dev/null`.then do |v|
      v.empty? ? '0.0.0.dev' : v.tr('-', '.')
    end
  end
end
