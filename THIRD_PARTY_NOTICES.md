# Third-party notices

The project's own license is in [LICENSE](LICENSE). The notices below apply to the specifically identified material; they do not assign ownership of the whole project to an upstream author. Separately installed dependencies retain their own licenses and notices.

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
