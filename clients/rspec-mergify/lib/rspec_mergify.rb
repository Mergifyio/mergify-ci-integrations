# frozen_string_literal: true

require_relative 'mergify/rspec'
require_relative 'mergify/rspec/ci_insights'
require_relative 'mergify/rspec/formatter'
require_relative 'mergify/rspec/configuration'

# Initialize singleton (only does real work when in CI)
Mergify::RSpec.ci_insights = Mergify::RSpec::CIInsights.new

# Register hooks and formatter
Mergify::RSpec::Configuration.setup!
