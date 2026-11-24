# Changelog

Every notable change to shipshape, newest first. Versions follow
[Semantic Versioning](https://semver.org/). While the version is 0.x, a minor release may
change behaviour or configuration; such changes are listed first, under **Breaking**.

## [0.2.0](https://github.com/justmytwospence/shipshape/releases/tag/v0.2.0) - 2026-11-24

### Breaking

- Drop v1 tables, columns and states (migration 034) ([4b94acb](https://github.com/justmytwospence/shipshape/commit/4b94acbed309baec2eb1613bf210c6ebf041d9f9))
- Stop reading v1 labels; a leftover one makes a service ask ([698e4dd](https://github.com/justmytwospence/shipshape/commit/698e4dddca56157705f81f2293d19dbbaf4a5000))
- Policy.yaml no longer folds v1 keys ([3026c7b](https://github.com/justmytwospence/shipshape/commit/3026c7b966d7cdf55e5ffae4bf579e29fe4fc0c5))
- Drop the v1 pull-request cutover and octokit ([bc1695c](https://github.com/justmytwospence/shipshape/commit/bc1695cba9d6aa9184a868efd49940614e10c04c))
- **review:** Sonnet reads, Opus drafts, $15 a month by default ([d6dfea1](https://github.com/justmytwospence/shipshape/commit/d6dfea1488cf93608e3e9a1a1fd64e0cbd5fc668))

### Features

- **ui:** Link the setup page and checklist to their guides ([0dda216](https://github.com/justmytwospence/shipshape/commit/0dda216869fe592f19876a4b64a318c445288a07))
- Report the image's version and revision in one place ([5eacd25](https://github.com/justmytwospence/shipshape/commit/5eacd25c12a206dd1e962a06c3adc3917b0d0ac2))
- **db:** Build a new database from one generated baseline ([4b08c7c](https://github.com/justmytwospence/shipshape/commit/4b08c7cc5db5aa94658e7346b718dd85fb22a308))
- Say which Traefik middlewares keep a router private ([18cbc87](https://github.com/justmytwospence/shipshape/commit/18cbc87fcc9df5ae5af20a05dac3fa913ce86f58))
- **forks:** Name the fork branch and tag prefix in policy.yaml ([4e7877c](https://github.com/justmytwospence/shipshape/commit/4e7877c2917b61bd878b48890c8ab7735b3c441d))
- **dev:** Shots.mjs opens dialogs and names single shots ([ed88de6](https://github.com/justmytwospence/shipshape/commit/ed88de63f0be7bac6ea12f8be41a9e15c20edfe1))
- **dev:** A demo repository and seeded history for dev:ui --demo ([93d03b8](https://github.com/justmytwospence/shipshape/commit/93d03b87c27b585e35e33b5cf1d6ea25e96d9cf7))
- **ui:** Column headers, review states, recent deploys, field errors ([43fdf6c](https://github.com/justmytwospence/shipshape/commit/43fdf6c65c5fec10c2243de2785a7a6cf242a07e))
- **ui:** The phone sees the machine's state, the theme and the scan ([c36f8ec](https://github.com/justmytwospence/shipshape/commit/c36f8ec2147c999fda6a64693646f001d4bdee11))
- **ui:** A mark of its own ([b7b3857](https://github.com/justmytwospence/shipshape/commit/b7b3857bee665509730143b1d75e27b583d51a75))
- **ui:** Watch and stop watching a service from the UI ([4b387d2](https://github.com/justmytwospence/shipshape/commit/4b387d230410456b0c3e989ee5312df905c6b071))
- **ui:** A getting-started checklist and empty states that explain ([92e7f77](https://github.com/justmytwospence/shipshape/commit/92e7f772d4cf922872a7790c39c0eae77b66523a))
- **health:** Answer 503 when the database or the main loop is stuck ([cac990f](https://github.com/justmytwospence/shipshape/commit/cac990f317195770d5b47eff03cb87a2746e9a0b))
- Shut down gracefully on SIGTERM ([2bb49a2](https://github.com/justmytwospence/shipshape/commit/2bb49a242f6c2e7f66096af6dedc7951395a7052))
- **deploy:** One runner with a per-stack lock that syncs first ([fd00bc3](https://github.com/justmytwospence/shipshape/commit/fd00bc31ab009600419ce978398e6417bce9cd65))
- **lifecycle:** Track background work for a clean shutdown ([d806515](https://github.com/justmytwospence/shipshape/commit/d8065155314b31923365d8993e29e5bc7a0adbf9))
- Convert-v1 rewrites v1 labels and policy keys ([953f3ba](https://github.com/justmytwospence/shipshape/commit/953f3bad89004296e84d94c1e71a00dad19f5ab5))
- **policy:** Shipshape.class: skip stops tracking a service ([ac4df1b](https://github.com/justmytwospence/shipshape/commit/ac4df1b3933cb5dbcb58feded77286c6cc2a5367))
- **notify:** Discord, Gotify and Apprise sinks ([668fe0b](https://github.com/justmytwospence/shipshape/commit/668fe0b35de9452802ceb2952c9fd37f6357a6d6))
- **notify:** A webhook needs no token ([eaef3c6](https://github.com/justmytwospence/shipshape/commit/eaef3c6cd8960554f1be89ee43a7aa592c106196))
- **review:** Review.web switches the reader's web tools ([662403e](https://github.com/justmytwospence/shipshape/commit/662403ebff8580bc5c7ea01686a6d9084950f8f9))
- **llm:** Serve every model call from a custom endpoint ([9fcec0e](https://github.com/justmytwospence/shipshape/commit/9fcec0ed1582f42397391641dcd5645c6512520d))
- **policy:** Look for shipshape.yaml first; create it on first save ([bab8637](https://github.com/justmytwospence/shipshape/commit/bab86372c904b2f59108605345df8043118039ac))
- **compose:** Find every compose file name; deploy with the override ([9a1f51b](https://github.com/justmytwospence/shipshape/commit/9a1f51be844ef763083ab5b8cd96229ed59d2fb6))
- **git:** Publish to the configured branch, not always main ([9a1145c](https://github.com/justmytwospence/shipshape/commit/9a1145cf6f06153c467527fe63f05639e851df2f))
- **git:** Sign in to any https git host, each token to its own host ([4749271](https://github.com/justmytwospence/shipshape/commit/4749271fe370fb88767deab12d429f0c5e7ffbff))
- **web:** Sign in with a password, or a proxy given by CIDR and header ([a5e030e](https://github.com/justmytwospence/shipshape/commit/a5e030e46c188d46b2964b141442c48e8df1842c))

### Security

- Refuse NAT64, 6to4 and IPv4-compatible private addresses ([fefd1a8](https://github.com/justmytwospence/shipshape/commit/fefd1a8391b1813156c726819552b6a95e54d1b8))
- Keep drafted edits inside the services they name ([728668e](https://github.com/justmytwospence/shipshape/commit/728668ee7859db83bd82b7e7ce793b52891fff96))
- Render only http(s) links from models and feeds ([94699a9](https://github.com/justmytwospence/shipshape/commit/94699a9551db73f8abaa4ef076b1c9e9c4c65606))
- Require MCP_TOKEN for the MCP listener ([be7a7c4](https://github.com/justmytwospence/shipshape/commit/be7a7c488e044311d196d0981ce568a30e3455e4))
- Hold a drafted change until it is shipped after drafting ([534ff2a](https://github.com/justmytwospence/shipshape/commit/534ff2a291225df58bab1a3492b43fc41c8a5cfb))

### Fixes

- **auth:** Let a browser send its origin with the sign-in form ([5f2c466](https://github.com/justmytwospence/shipshape/commit/5f2c466e05ff5a9fb4af1894602b45cb59470de0))
- Lint errors Biome finds ([1d0d181](https://github.com/justmytwospence/shipshape/commit/1d0d181d5af828f0106ff9ffab27ced31fb66d08))
- **ui:** What the first look at the demo found ([5f55d5d](https://github.com/justmytwospence/shipshape/commit/5f55d5db926185ea5c16cf867104ed0bd979cd9f))
- **ui:** Watch all publishes once, after its last commit ([2cced44](https://github.com/justmytwospence/shipshape/commit/2cced440477ed803d66b9383ed44636411299112))
- **labels:** Writing a class removes shipshape.claude too ([a215488](https://github.com/justmytwospence/shipshape/commit/a2154886e8c6bd36ee487c0869a28baf990a58c5))
- **ui:** Accessibility: contrast, headings, focus, landmarks ([5529dca](https://github.com/justmytwospence/shipshape/commit/5529dca962a022c6f4ff1fd24233306aa96b9d7d))
- **ui:** Versioned assets, and long tags that wrap ([9797dc7](https://github.com/justmytwospence/shipshape/commit/9797dc79a0b2e359ed889d71aab4c7aa4ab207a3))
- **ui:** Times in the browser, in the server's zone ([be10a60](https://github.com/justmytwospence/shipshape/commit/be10a60eba717447c643db0e26b554083edac1b6))
- **ui:** Quiet polls, a connection banner, honest error toasts ([454315a](https://github.com/justmytwospence/shipshape/commit/454315a71746f95e3a56c78a7472952af7c9fc12))
- **ui:** One name per thing, and no pull requests ([25b0437](https://github.com/justmytwospence/shipshape/commit/25b043744f3b78b995b92b5bd48b88cb9e90fd33))
- **ui:** Keyboard, theme and storage fixes; skip asks first ([b79d486](https://github.com/justmytwospence/shipshape/commit/b79d48615440471d6ea2e55e4876184f777b0559))
- Log swallowed errors; keep services of an unreadable compose file ([fd1e903](https://github.com/justmytwospence/shipshape/commit/fd1e9034113749185c7ca423825e4339223cc96b))
- **scheduler:** Validate scan.cron and keep a working schedule ([ea6bd4b](https://github.com/justmytwospence/shipshape/commit/ea6bd4b21e0bacafa83f8125957acd392b08c3e9))
- **ship:** Record a ship before pushing it; reconcile after a crash ([3b96f5f](https://github.com/justmytwospence/shipshape/commit/3b96f5f55873e72c5a8af5a541b38ea867aace87))
- **web:** Name only documented proxies on the setup page ([ce3124a](https://github.com/justmytwospence/shipshape/commit/ce3124adb011c1d8df65f0b6e347af25a07d7c1f))
- **policy:** Bring the starter file up to date ([13de961](https://github.com/justmytwospence/shipshape/commit/13de961d17530caa8069d9589979a2979aac3c88))
- **settings:** Refuse a zero budget with a reason ([a75e015](https://github.com/justmytwospence/shipshape/commit/a75e015ff7cd3454eef06a24ab9ed6cd937b19cd))
- **web:** Refuse a password too long to type in ([c5e59bc](https://github.com/justmytwospence/shipshape/commit/c5e59bcdb8e6122cf96273de20962bd513037f7f))
- **web:** Key the session fingerprint per install ([78ccde6](https://github.com/justmytwospence/shipshape/commit/78ccde605dc7cfbaef19c88019b6bd73590b424a))
- **git:** Refuse plain-http remotes ([1afcf29](https://github.com/justmytwospence/shipshape/commit/1afcf299fcc4237e51b48859cc06b4881d6c8051))
- **ui:** Name the screen, the reader and the webhook neutrally ([69c7303](https://github.com/justmytwospence/shipshape/commit/69c7303e06434b0acf21a54d22afde7fab879f45))
- **web:** Styled 404, 500 and action-link error pages ([2133aad](https://github.com/justmytwospence/shipshape/commit/2133aadc6bea6e1b52ac1fdc51faf56a44b96681))
- **notify:** Ignore an action secret shorter than 32 characters ([d964735](https://github.com/justmytwospence/shipshape/commit/d9647357516eaef44abc8a5d0c17e595990965fc))
- **restore:** Keep restore points readable by shipshape alone ([ba2c421](https://github.com/justmytwospence/shipshape/commit/ba2c4213a8dca3a0b1771b5a9d6725021d5d5ed0))
- **rules:** Never infer a rule wider than the card it answers ([1b3166c](https://github.com/justmytwospence/shipshape/commit/1b3166cc30afd816b201cb450ea9e94a9b4dd5af))
- **registry:** Check where redirects, token realms and pages lead ([4a4cf92](https://github.com/justmytwospence/shipshape/commit/4a4cf924e06eee0c7b3409eb6a5f0e6dcd708746))
- **git:** Offer credentials only to the hosts that need them ([2180732](https://github.com/justmytwospence/shipshape/commit/21807321bc22b8353921604cf46bd542b28aa3bc))
- **web:** Add a content security policy and security headers ([ba618ce](https://github.com/justmytwospence/shipshape/commit/ba618ce7bcde20b5ee262795f0d3b994bf1e333a))
- **dev:** Serve the sandbox UI behind a signing-in proxy ([f0ea3b0](https://github.com/justmytwospence/shipshape/commit/f0ea3b0eab6e108e9215cabab19717ad929b0921))

### Performance

- **db:** Cache only revalidatable responses and prune the rest ([f59fed0](https://github.com/justmytwospence/shipshape/commit/f59fed059b893b845959d228538cea39b2d95963))
- **notes:** Read HTML release notes in linear time ([fa02619](https://github.com/justmytwospence/shipshape/commit/fa02619a0b10d3e481504dbe69aa5d402a9c19bd))


