# frozen_string_literal: true

require 'spec_helper'
require 'mergify/rspec/rust_trace_exporter'

RSpec.describe Mergify::RSpec::RustTraceExporter do
  # Spans come from a real TracerProvider rather than doubles: the point of
  # this class is the shape the SDK actually hands an exporter, which a stubbed
  # span would let us guess wrong.
  def finished_spans
    resource = OpenTelemetry::SDK::Resources::Resource.create('service.name' => 'rspec-mergify',
                                                              'cicd.pipeline.run.attempt' => 2)
    provider = OpenTelemetry::SDK::Trace::TracerProvider.new(resource: resource)
    capture = OpenTelemetry::SDK::Trace::Export::InMemorySpanExporter.new
    provider.add_span_processor(OpenTelemetry::SDK::Trace::Export::SimpleSpanProcessor.new(capture))
    tracer = provider.tracer('rspec-mergify', '1.0')

    session = tracer.start_span('rspec session')
    child = tracer.start_span('foo_spec.rb[1:1]', with_parent: OpenTelemetry::Trace.context_with_span(session))
    child.set_attribute('test.case.result.status', 'failed')
    child.status = OpenTelemetry::Trace::Status.error('expected true, got false')
    child.finish
    session.finish

    capture.finished_spans
  end

  let(:client) { instance_double(Mergify::RSpec::Native::Client, upload_trace: nil) }
  let(:exporter) { described_class.new(client) }

  it 'reports success and sends nothing when there are no spans' do
    expect(exporter.export([])).to eq(OpenTelemetry::SDK::Trace::Export::SUCCESS)
    expect(client).not_to have_received(:upload_trace)
  end

  it 'sends the resource attributes once, keyed as strings' do
    exporter.export(finished_spans)

    expect(client).to have_received(:upload_trace).with(
      hash_including('service.name' => 'rspec-mergify', 'cicd.pipeline.run.attempt' => 2), anything
    )
  end

  it 'sends every span, with ids the widths OpenTelemetry fixes' do
    exporter.export(finished_spans)

    expect(client).to have_received(:upload_trace) do |_resource, spans|
      expect(spans.size).to eq(2)
      spans.each do |span|
        expect(span['trace_id'].bytesize).to eq(16)
        expect(span['span_id'].bytesize).to eq(8)
        expect(span['end_unix_nano']).to be >= span['start_unix_nano']
      end
    end
  end

  it 'omits the parent of a root span rather than sending the all-zero id' do
    exporter.export(finished_spans)

    expect(client).to have_received(:upload_trace) do |_resource, spans|
      root = spans.find { |s| s['name'] == 'rspec session' }
      child = spans.find { |s| s['name'] == 'foo_spec.rb[1:1]' }

      expect(root).not_to have_key('parent_span_id')
      expect(child['parent_span_id']).to eq(root['span_id'])
    end
  end

  it 'carries status and message across' do
    exporter.export(finished_spans)

    expect(client).to have_received(:upload_trace) do |_resource, spans|
      child = spans.find { |s| s['name'] == 'foo_spec.rb[1:1]' }

      expect(child['status']).to eq('error')
      expect(child['status_message']).to eq('expected true, got false')
      expect(child['attributes']).to include('test.case.result.status' => 'failed')
    end
  end

  it 'reports failure rather than raising when the upload fails' do
    allow(client).to receive(:upload_trace).and_raise(Mergify::RSpec::Native::ApiError.new('HTTP 500'))

    expect(exporter.export(finished_spans)).to eq(OpenTelemetry::SDK::Trace::Export::FAILURE)
  end

  # The examples above use a double, which cannot reject a shape the binding
  # would. This one runs the whole chain -- real SDK spans, the real binding,
  # a real socket -- so a type the conversion gets wrong fails here.
  describe 'against the real binding', if: Mergify::RSpec::Native.available? do
    around do |example|
      WebMock.allow_net_connect!
      example.run
    ensure
      WebMock.disable_net_connect!
    end

    it 'converts SDK spans into something the client accepts' do
      with_stub_api(status: 200, body: '{}') do |url, paths|
        client = Mergify::RSpec::Native::Client.new(url, 'token', 'Mergifyio', 'rspec-mergify', '1.0')

        expect(described_class.new(client).export(finished_spans))
          .to eq(OpenTelemetry::SDK::Trace::Export::SUCCESS)
        expect(paths.first).to include('/traces')
      end
    end
  end
end
