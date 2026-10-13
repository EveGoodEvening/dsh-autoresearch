# Third-party notices

The project's own license is in [LICENSE](LICENSE). The notices below apply to the specifically identified material; they do not assign ownership of the whole project to an upstream author. Separately installed dependencies retain their own licenses and notices.

## DeepSeek Harness — invariant companion registration

The registration scaffold in `src/invariant.ts`, distributed as `lib/invariant.js` and its declarations, follows the DeepSeek Harness Agent invariant companion: the package identity, companion name, `invariants` injection, installer and `ctx.invariants.register(PACKAGE_NAME, install)` registration. The package names and installer are changed for this plugin; the upstream Agent status-checking implementation is not included. Attribution is retained conservatively for this matching scaffold.

Sources:

- Published [`@deepseek-ai/dsh-agent@0.1.0-rc.6`](https://registry.npmjs.org/@deepseek-ai/dsh-agent/-/dsh-agent-0.1.0-rc.6.tgz): `package/lib/invariant.js` and `package/LICENSE`. Archive integrity: `sha512-vtqq2pWTrzn0dKfj5kREZRpP82AwtGjGx9V1lYnKvF+Uc/a8zyWbSvjDE7V1d3YQAQJzs2cWO31hURWDekDXIA==`.
- Matching [TypeScript source](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/core/agent/src/invariant.ts) and [MIT license](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/LICENSE) at the declared DSH `0.2.0-rc.2` release, commit `639ed015397290b3745d163aafe02ffee4aa3f84`.

The following notice is reproduced from the published `0.1.0-rc.6` package. It is not a license claim about earlier DSH revisions, some of which used BSD-3-Clause.

```text
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Karpathy autoresearch — protocol descriptions

The Chinese summaries of the original research protocol in `docs/plan/handoff-2026-0830.md` (the original-principles and crash-handling discussions) and `docs/plan/handoff-2026-0903.md` (the original-principles discussion) paraphrase Andrej Karpathy's `autoresearch` README and agent instructions. The recovered implementation's [README](https://github.com/EveGoodEvening/dsh-autoresearch/blob/3ca85a17c03d15488269b3dbc339e3ec135d98c3/README.md) and [experiment-worker prompt](https://github.com/EveGoodEvening/dsh-autoresearch/blob/3ca85a17c03d15488269b3dbc339e3ec135d98c3/src/index.ts) also adapt that protocol to DSH. Those historical files and planning documents are not shipped in the current npm package.

This is attribution for protocol descriptions and paraphrases, not a claim that this plugin contains Karpathy's training implementation or that he authored its runtime. The current README separately credits the design inspiration.

Pinned sources at commit `228791fb499afffb54b46200aca536f79142f117`:

- [README.md](https://github.com/karpathy/autoresearch/blob/228791fb499afffb54b46200aca536f79142f117/README.md)
- [program.md](https://github.com/karpathy/autoresearch/blob/228791fb499afffb54b46200aca536f79142f117/program.md)

The upstream README's license declaration is reproduced verbatim:

```markdown
## License

MIT
```

That revision does not provide a separate `LICENSE` file or an explicit copyright notice in these two documents. No copyright year or notice has been invented here. The standard MIT license text is available from [SPDX](https://spdx.org/licenses/MIT.html).
