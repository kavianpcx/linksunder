# Contributing to LinkSunder

Thanks for helping improve LinkSunder. You do not need write access to the
official repository. Contributions come from your own fork and are reviewed
before they enter `main`.

## 1. Fork the project

Open [kavianpcx/linksunder](https://github.com/kavianpcx/linksunder) and select
**Fork**. Work in your copy of the repository.

## 2. Clone your fork

Install Git and Node.js 22.12 or newer (Node.js 24 LTS is recommended), then
replace `<your-github-username>` with your GitHub username:

```sh
git clone https://github.com/<your-github-username>/linksunder.git
cd linksunder
npm ci
```

## 3. Create a branch

Use a short name that describes the change:

```sh
git switch -c fix/short-description
```

For a new capability, a name such as `feat/short-description` works well.

## 4. Make a focused change

Follow the existing TypeScript, React, and Fastify patterns. Add or update tests
for behavior changes. Keep `data/`, credentials, private scenarios, and reports
out of commits. Discuss a large feature or a new dependency in an Issue before
building it.

## 5. Set up and check your changes

Run setup once to prepare a local browser. On Windows, setup can use an existing
Chrome or Edge installation; otherwise it installs Playwright Chromium. On
Linux, install the browser and system dependencies with
`npx playwright install --with-deps chromium` if they are not already installed.

```sh
npm run setup
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run build
```

E2E tests start their own local server on port 4317, so stop another LinkSunder
development server before running them. If a platform-specific check cannot be
run, mention that in the pull request.

## 6. Commit your change

Use a clear message that describes the change:

```sh
git add path/to/changed-file
git commit -m "Describe the change"
```

## 7. Push to your fork

```sh
git push -u origin fix/short-description
```

## 8. Open a pull request

On GitHub, open a pull request from your fork and branch into
[`kavianpcx/linksunder`](https://github.com/kavianpcx/linksunder), targeting
`main`. Describe the user problem, the change, related Issues, and checks you
ran. Include screenshots for visible changes when useful.

## 9. Review and merge

The maintainer reviews contributions and may ask for changes. Passing automated
checks does not automatically accept a contribution. The authorized maintainer
decides whether and when to merge it into the official repository. Contributors
do not need, and will not be given, direct write access to the upstream repo.

LinkSunder is distributed under the existing [MIT License](LICENSE). Forks and
other uses are governed by that license; linking back to the upstream project is
appreciated but is not an additional license requirement.
