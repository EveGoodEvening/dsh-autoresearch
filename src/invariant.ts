/** Package-owned invariant companion for `dsh-autoresearch`. @module dsh-autoresearch/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = 'dsh-autoresearch'

/** Cordis companion plugin name. */
export const name = 'autoresearch-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * The controller introduced by later implementation chunks owns runtime invariants; this companion
 * reserves the package identity without duplicating lifecycle enforcement.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
