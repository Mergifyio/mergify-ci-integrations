#!/usr/bin/env ruby
# frozen_string_literal: true

# Install the built gem the way a user would, on this runner's platform, and
# prove the result actually works.
#
# The Ruby counterpart of check-ts-install.mjs and check-pytest-install.py.
# Installing and requiring is the easy half; the half that matters is the last
# check, which asserts RSpec really registers the formatter. The chain is
# `require 'rspec_mergify'` -> Configuration.setup! -> add_formatter, and if it
# silently does not complete the gem installs, requires without error, and
# reports nothing -- the same shape as the missing pytest11 entry point, and as
# the runner path that shipped broken in @mergifyio/vitest for five releases.
#
# Every probe runs on a scrubbed environment. This job runs *inside* GitHub
# Actions, so the runner's own GITHUB_* would otherwise be what the binding
# detects, and detection is precedence-ordered: an assertion written against
# the ambient provider passes here and nowhere else. Scrubbing and then
# supplying a synthetic provider keeps the expected values fixed, and asserting
# them proves the binding reads the environment rather than merely loading.
#
# add_formatter is guarded by Utils.in_ci?, so the probes set CI. Without it the
# last check would pass while proving nothing.
#
# Only the platform this runner can execute is covered. musl and the foreign
# architectures would need a container or QEMU, which is the same gap the other
# two clients have.
#
# Usage: check-rspec-install.rb <dir> <version>

require 'open3'
require 'tmpdir'

dir, version = ARGV
abort('usage: check-rspec-install.rb <dir> <version>') unless dir && version

@failed = false

def fail!(message, output = nil)
  warn("::error::#{message}")
  warn(output.to_s.lines.map { |l| "  #{l}" }.join) if output && !output.empty?
  @failed = true
end

# Everything that would make detection depend on where this runs: the ambient
# provider's variables, the bundler context of the checkout, and the token,
# whose absence keeps the probes from talking to the API at all.
def scrubbed_env
  names = ENV.keys.grep(/\A(GITHUB|RUNNER|CIRCLE|BUILDKITE|JENKINS)_/)
  names += %w[CI GITHUB_ACTIONS CIRCLECI JENKINS_URL BUILDKITE RSPEC_MERGIFY_ENABLE
              _PYTEST_MERGIFY_TEST _RSPEC_MERGIFY_TEST MERGIFY_TOKEN MERGIFY_API_URL
              MERGIFY_TRACEPARENT RUBYOPT BUNDLE_GEMFILE]
  names.to_h { |name| [name, nil] }
end

# A provider the binding has to map, with values no runner would produce.
SYNTHETIC_CI = {
  'CI' => 'true',
  'GITHUB_ACTIONS' => 'true',
  'GITHUB_REPOSITORY' => 'Mergifyio/probe',
  'GITHUB_REPOSITORY_ID' => '42',
  'GITHUB_SERVER_URL' => 'https://github.com',
  'GITHUB_WORKFLOW' => 'probe',
  'GITHUB_RUN_ID' => '1',
  'GITHUB_REF_NAME' => 'probe-branch',
  'GITHUB_SHA' => '0' * 40
}.freeze

# The gem this runner can execute. Asking RubyGems which platform it is, rather
# than pattern-matching names ourselves, means a gem it would decline is a
# failure surfaced here rather than by a user.
def platform_gem(dir, version)
  local = Gem::Platform.local
  candidates = Dir.glob(File.join(dir, "rspec-mergify-#{version}-*.gem"))
  candidates.find do |path|
    Gem::Platform.new(File.basename(path, '.gem').sub("rspec-mergify-#{version}-", '')) =~ local
  end
end

# Deliberately the `gem` belonging to the Ruby running this script rather than
# whatever PATH resolves: the installer and the prober have to be one Ruby, or
# a mismatch shows up as the extension mysteriously not loading.
GEM = File.join(RbConfig::CONFIG['bindir'], 'gem')

def install(gem_home, path)
  out, status = Open3.capture2e({ 'GEM_HOME' => gem_home, 'GEM_PATH' => gem_home },
                                GEM, 'install', '--no-document', path)
  fail!("installing #{File.basename(path)} failed", out) unless status.success?
  status.success?
end

# Run outside the source tree so nothing can be satisfied by a checkout that
# happens to be lying around.
def run(gem_home, command, env: {}, chdir: nil)
  block = lambda do |cwd|
    Open3.capture2e(
      scrubbed_env.merge('GEM_HOME' => gem_home, 'GEM_PATH' => gem_home).merge(env),
      *command, chdir: cwd
    )
  end
  chdir ? block.call(chdir) : Dir.mktmpdir(&block)
end

def probe(gem_home, script, env: {})
  run(gem_home, [RbConfig.ruby, '-e', script], env: env)
end

native = platform_gem(dir, version)
if native.nil?
  fail!("no gem matches #{Gem::Platform.local}, so nothing here could be installed")
else
  Dir.mktmpdir do |home|
    break unless install(home, native)

    out, status = probe(home, <<~RUBY, env: SYNTHETIC_CI)
      require 'mergify/rspec/native'
      raise 'the extension did not load' unless Mergify::RSpec::Native.available?

      provider = Mergify::RSpec::Native.detect_provider
      raise "detect_provider returned \#{provider.inspect}" unless provider == 'github_actions'

      name = Mergify::RSpec::Native.detect_repository_name
      raise "detect_repository_name returned \#{name.inspect}" unless name == 'Mergifyio/probe'

      attributes = Mergify::RSpec::Native.detect_attributes
      raise 'detect_attributes returned nothing' if attributes.empty?
      %w[cicd.provider.name vcs.repository.name vcs.ref.head.name].each do |key|
        raise "attributes have no \#{key}: \#{attributes.inspect}" unless attributes[key]
      end
      raise "wrong repository: \#{attributes.inspect}" unless attributes['vcs.repository.name'] == 'Mergifyio/probe'
      puts 'binding ok'
    RUBY
    fail!("#{File.basename(native)}: the binding does not work once installed", out) unless status.success?

    # The formatter has to be registered by a real RSpec run, not merely
    # required. No token is set, so this reports and uploads nothing.
    Dir.mktmpdir do |project|
      # An empty example on purpose: the gem depends on rspec-core alone, so
      # rspec-expectations is not necessarily installed alongside it, and this
      # is probing formatter registration rather than matchers.
      File.write(File.join(project, 'a_spec.rb'), "RSpec.describe('probe') { it('runs') {} }\n")
      # Through RbConfig.ruby for the same reason as GEM: the binstub's shebang
      # would otherwise pick up whatever ruby PATH resolves to.
      command = [RbConfig.ruby, File.join(home, 'bin', 'rspec'), '--require', 'rspec_mergify', 'a_spec.rb']
      out, status = run(home, command, env: SYNTHETIC_CI, chdir: project)
      if !status.success?
        fail!('a real RSpec run with the gem required failed', out)
      elsif !out.include?('--- Mergify CI ---')
        fail!('RSpec ran but the Mergify formatter was never registered', out)
      end
    end
  end
end

# The plain gem is the fallback for platforms with no prebuilt one; its whole
# job is to install anywhere and degrade rather than fail.
plain = File.join(dir, "rspec-mergify-#{version}.gem")
if File.exist?(plain)
  Dir.mktmpdir do |home|
    break unless install(home, plain)

    out, status = probe(home, <<~RUBY, env: SYNTHETIC_CI)
      require 'mergify/rspec/native'
      raise 'the plain gem carries an extension' if Mergify::RSpec::Native.available?
      raise 'detection raised instead of degrading' unless Mergify::RSpec::Native.detect_provider.nil?
      raise 'attributes raised instead of degrading' unless Mergify::RSpec::Native.detect_attributes.empty?
      puts 'fallback ok'
    RUBY
    fail!('the plain gem does not fail open', out) unless status.success?
  end
else
  fail!("missing #{File.basename(plain)}")
end

abort('::error::install checks failed') if @failed
puts "ok: #{File.basename(native)} and the plain gem behave"
