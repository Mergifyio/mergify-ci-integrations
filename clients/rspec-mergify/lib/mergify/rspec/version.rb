# frozen_string_literal: true

module Mergify
  module RSpec
    VERSION = begin
      v = `git describe --tags 2>/dev/null`.strip.delete_prefix('v')
      if v.empty?
        '0.0.0.dev'
      elsif v.include?('-')
        # e.g. "0.1.0-3-gabc123" -> "0.1.0.dev3"
        parts = v.split('-')
        "#{parts[0]}.dev#{parts[1]}"
      else
        v
      end
    end
  end
end
