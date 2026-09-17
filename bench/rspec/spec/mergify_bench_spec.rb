# frozen_string_literal: true

RSpec.describe 'mergify_bench' do
  it('passes') {}

  it('fails') { raise 'boom' }

  it('skipped') { skip 'skipped on purpose' }

  it('évènement') {}
end
