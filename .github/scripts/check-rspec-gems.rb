#!/usr/bin/env ruby
# frozen_string_literal: true

# Check the built gems before they can become a draft.
#
# A build that succeeds proves nothing about what it produced, and the gem has
# a failure mode the other clients do not: a platform gem missing the extension
# for one Ruby installs without complaint, loads, and reports no CI at all --
# because the loader is deliberately fail-open. Detection would silently stop
# working for everyone on that Ruby, with no error anywhere. Nothing else in
# the pipeline would notice.
#
# It also pins the glibc floor. The extensions use a handful of newer glibc
# functions only when they exist, but the linker records a version requirement
# for each one it finds in the glibc it links against, and the loader enforces
# those even for symbols the code treats as optional. The floor is therefore
# whatever the build images happen to ship, and raising it silently drops
# distributions: the TypeScript binaries drifted to 2.39 that way, which is
# newer than Ubuntu 22.04, Debian 12 and RHEL 9. 2.30 is accepted, matching
# every other precompiled Rust gem; this check is what keeps it there.
#
# Usage: check-rspec-gems.rb <dir> <version>

require 'rubygems/package'
require 'tmpdir'

# Pinned as a set, like the wheels are: a matrix leg that quietly stops
# producing a gem is how a release ships missing a platform, and "six instead
# of seven" is not something a release log makes obvious.
PLATFORMS = %w[
  x86_64-linux x86_64-linux-musl
  aarch64-linux aarch64-linux-musl
  x86_64-darwin arm64-darwin
  x64-mingw-ucrt
].freeze

# Every Ruby the cross-compile builds for. A fat gem carries one extension per
# entry, since a compiled extension is valid for one Ruby minor only.
RUBIES = %w[3.1 3.2 3.3 3.4 4.0].freeze

EXTENSION = /\.(so|bundle|dll)\z/

# The highest glibc any linux-gnu extension may require. Users below it install
# the gem, load nothing, and report nothing, so this is a distribution-support
# decision rather than a build detail. The musl gems only carry musl's own
# GLIBC_2.0 compatibility names, so they pass this without anything to say.
GLIBC_FLOOR = Gem::Version.new('2.30')

# Whatever can read an ELF version-requirements table. Ubuntu runners have
# binutils; the alternates keep the script runnable on a developer machine.
READELF = %w[readelf llvm-readelf eu-readelf].find do |tool|
  system(tool, '--version', out: File::NULL, err: File::NULL)
end

def fail!(message)
  warn("::error::#{message}")
  @failed = true
end

def check_common(spec, files, label, version)
  fail!("#{label}: version is #{spec.version}, expected #{version}") unless spec.version.to_s == version
  fail!("#{label}: licenses are #{spec.licenses.inspect}, expected Apache-2.0") unless spec.licenses == ['Apache-2.0']
  fail!("#{label}: LICENSE is not packaged") unless files.include?('LICENSE')
  fail!("#{label}: README.md is not packaged") unless files.include?('README.md')
  # Rust sources in a gem would imply compiling on install, which cannot work:
  # the crate path-depends on the workspace, which is not inside the gem.
  rust = files.grep(/\Aext\/.*\.rs\z/)
  fail!("#{label}: ships Rust sources #{rust.inspect}") unless rust.empty?
end

# The glibc versions an extension demands at load time. `readelf -V` lists the
# version-requirements table; our extensions define no GLIBC_* versions of
# their own, so every match here is something the loader will insist on.
def glibc_versions(path)
  out = IO.popen([READELF, '-V', path], err: File::NULL, &:read)
  out.scan(/Name: GLIBC_(\d+(?:\.\d+)+)/).flatten.map { |v| Gem::Version.new(v) }
end

def check_glibc_floor(path, platform, label)
  return unless platform.include?('linux')
  return fail!("#{label}: no readelf available to check the glibc floor") unless READELF

  Dir.mktmpdir do |dir|
    Gem::Package.new(path).extract_files(dir)
    extensions = Dir.glob(File.join(dir, 'lib/mergify/rspec/*/mergify_ci.so')).sort
    # The per-Ruby presence check above already fails when these are missing;
    # bailing here too would report the same fault twice.
    extensions.each do |so|
      highest = glibc_versions(so).max
      next if highest.nil? || highest <= GLIBC_FLOOR

      ruby = File.basename(File.dirname(so))
      fail!("#{label}: the Ruby #{ruby} extension needs glibc #{highest}, above the #{GLIBC_FLOOR} floor")
    end
  end
end

def check_platform_gem(path, platform, version)
  spec = Gem::Package.new(path).spec
  files = spec.files
  label = "#{platform} gem"

  check_common(spec, files, label, version)
  fail!("#{label}: platform is #{spec.platform}, expected #{platform}") unless spec.platform.to_s == platform
  # A declared extension makes `gem install` compile, and it cannot.
  fail!("#{label}: declares extensions #{spec.extensions.inspect}") unless spec.extensions.empty?

  RUBIES.each do |ruby|
    packed = files.grep(%r{\Alib/mergify/rspec/#{Regexp.escape(ruby)}/mergify_ci#{EXTENSION}})
    fail!("#{label}: no extension for Ruby #{ruby}") if packed.empty?
  end

  check_glibc_floor(path, platform, label)
end

def check_ruby_gem(path, version)
  spec = Gem::Package.new(path).spec
  files = spec.files
  label = 'ruby gem'

  check_common(spec, files, label, version)
  fail!("#{label}: platform is #{spec.platform}, expected ruby") unless spec.platform.to_s == 'ruby'
  fail!("#{label}: declares extensions #{spec.extensions.inspect}") unless spec.extensions.empty?
  # This one is the fallback for platforms with no prebuilt gem; carrying a
  # native library would defeat that.
  native = files.grep(EXTENSION)
  fail!("#{label}: carries a native library #{native.inspect}") unless native.empty?
end

dir, version = ARGV
abort('usage: check-rspec-gems.rb <dir> <version>') unless dir && version

@failed = false
found = Dir.glob(File.join(dir, '*.gem')).sort
puts "checking #{found.size} gems in #{dir} for #{version}"

PLATFORMS.each do |platform|
  path = File.join(dir, "rspec-mergify-#{version}-#{platform}.gem")
  next fail!("missing #{File.basename(path)}") unless File.exist?(path)

  check_platform_gem(path, platform, version)
end

ruby_gem = File.join(dir, "rspec-mergify-#{version}.gem")
if File.exist?(ruby_gem)
  check_ruby_gem(ruby_gem, version)
else
  fail!("missing #{File.basename(ruby_gem)}")
end

expected = PLATFORMS.size + 1
fail!("expected #{expected} gems, found #{found.size}: #{found.map { |f| File.basename(f) }.inspect}") if found.size != expected

abort('::error::gem checks failed') if @failed
puts "ok: #{expected} gems, #{RUBIES.size} Rubies each, glibc #{GLIBC_FLOOR} or older"
