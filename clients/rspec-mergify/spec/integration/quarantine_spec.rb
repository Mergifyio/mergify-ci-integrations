# frozen_string_literal: true

require 'spec_helper'
require 'mergify/rspec/quarantine'

RSpec.describe 'Integration: Quarantine' do # rubocop:disable RSpec/DescribeClass
  it 'fetches and matches quarantined tests' do
    stub_request(:get, 'https://api.mergify.com/v1/ci/owner/repositories/repo/quarantines')
      .with(query: { branch: 'main' })
      .to_return(
        status: 200,
        body: {
          quarantined_tests: [
            { test_name: './spec/flaky_spec.rb[1:1]' },
            { test_name: './spec/flaky_spec.rb[1:2]' }
          ]
        }.to_json,
        headers: { 'Content-Type' => 'application/json' }
      )

    q = Mergify::RSpec::Quarantine.new(
      api_url: 'https://api.mergify.com',
      token: 'test-token',
      repo_name: 'owner/repo',
      branch_name: 'main'
    )

    expect(q.include?('./spec/flaky_spec.rb[1:1]')).to be true
    expect(q.include?('./spec/ok_spec.rb[1:1]')).to be false

    q.mark_as_used('./spec/flaky_spec.rb[1:1]')
    report = q.report
    expect(report).to include('owner/repo')
    expect(report).to include('main')
    expect(report).to include('Quarantined')
    expect(report).to include('./spec/flaky_spec.rb[1:1]')
    expect(report).to include('Unused')
    expect(report).to include('./spec/flaky_spec.rb[1:2]')
  end
end
