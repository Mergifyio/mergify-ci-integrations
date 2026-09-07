# frozen_string_literal: true

module Mergify
  module RSpec
    # Placeholder: the release workflow stamps the real version from the git tag
    # at build time, as it does for pytest-mergify's pyproject.toml and the TS
    # packages' package.json. This used to shell out to `git describe --tags`,
    # which resolved against whatever repository happened to be the working
    # directory at load time -- the monorepo's namespaced tags here, the user's
    # own tags once the gem was installed.
    VERSION = '0.0.0'
  end
end
