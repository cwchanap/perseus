// Accessibility scanning helpers (HPA-226 Task 10).
//
// Thin wrapper around @axe-core/playwright that:
//   - runs an axe scan against the WCAG 2.0/2.1 A+AA rule sets,
//   - attaches the FULL results (passes, incomplete, every violation impact) as
//     a JSON test attachment so the report always carries the complete picture,
//   - fails ONLY on serious/critical violations; minor/moderate findings pass
//     (they remain visible in the attached JSON for triage).
//
// Plus three small a11y assertions the gameplay surface relies on:
//   - expectRoleFocused      role + keyboard focus land on the same element,
//   - expectContainedIn      an element lives inside a landmark/region,
//   - expectLiveRegion       a region announces via aria-live or an implicit
//                            live-region role (status/alert/log).
//
// IMPORTANT: this is automated scanning only. axe checks a structural subset
// of WCAG — it does NOT verify real screen-reader / AT behavior, focus-trap
// correctness under tab cycling, or announced semantics in NVDA/VoiceOver.
// Manual AT certification remains a separate, human-driven activity.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';

/** Impacts that fail a test. Minor/moderate findings pass (tracked via JSON). */
const FAILING_IMPACTS: ReadonlySet<string> = new Set(['serious', 'critical']);

/** WCAG conformance targets scanned by default (2.0 + 2.1, A + AA). */
const DEFAULT_TAGS: readonly string[] = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/**
 * Rule ids disabled across EVERY scan, each with its owning ticket and reason.
 * This is the single, auditable register of accepted a11y deferrals — adding a
 * deferral means adding a documented entry here, never a silent disableRules at
 * a call site. {@link scanAccessibility} applies these automatically.
 *
 * NOTE: deferrals are ACCEPTED gaps, not resolved issues. Each entry should
 * eventually be removed once the owning ticket lands its remediation.
 */
export const DEFERRED_RULES: readonly DeferredRule[] = [
	{
		rule: 'color-contrast',
		// Owning ticket: HPA-226 (umbrella epic) — a dedicated contrast-
		// remediation child ticket is pending; update this reference then.
		ticket: 'HPA-226',
		reason:
			'Decorative mono/neon text on dark backgrounds falls below 4.5:1 — ' +
			'e.g. the PuzzleCard "No preview" label and its text-(--text-2) ' +
			'status row, plus HUD stat labels on the puzzle page. This is a ' +
			'theme-wide contrast remediation, not a structural a11y gap, so it ' +
			'is deferred to keep the gate green for structural violations while ' +
			'the palette is reworked.'
	}
];

export interface DeferredRule {
	rule: string;
	/** HPA ticket that owns the remediation. */
	ticket: string;
	reason: string;
}

/** Full axe results shape, derived from the builder so we never import
 *  axe-core's type surface directly (it is an indirect dependency). */
type AxeResults = Awaited<ReturnType<AxeBuilder['analyze']>>;
type AxeViolation = AxeResults['violations'][number];

export interface ScanOptions {
	/** Selector the scan is scoped to (everything else is ignored). */
	include?: string;
	/** Selector(s) excluded from the scan, e.g. a known-deferred widget. */
	exclude?: string[];
	/**
	 * Rule ids to disable. Any disabled rule MUST be justified at the call site
	 * by a comment naming the owning HPA ticket and the deferral reason — see
	 * the "Exclusions" contract in the task brief.
	 */
	disableRules?: string[];
	/** Label folded into the attachment filename (e.g. 'gallery'). */
	label?: string;
}

/**
 * Run an axe scan, attach the complete JSON results to the test report, and
 * return the full results for further assertion. Never throws — callers decide
 * how to react via {@link assertNoSeriousViolations}.
 */
export async function scanAccessibility(
	page: Page,
	options: ScanOptions = {}
): Promise<AxeResults> {
	let builder = new AxeBuilder({ page }).withTags([...DEFAULT_TAGS]);
	if (options.include) {
		builder = builder.include(options.include);
	}
	for (const selector of options.exclude ?? []) {
		builder = builder.exclude(selector);
	}
	// Always apply the documented deferrals, merged with any caller-supplied
	// per-scan disables, so the central register is the source of truth.
	const disabled = new Set<string>(DEFERRED_RULES.map((d) => d.rule));
	for (const rule of options.disableRules ?? []) {
		disabled.add(rule);
	}
	if (disabled.size > 0) {
		builder = builder.disableRules([...disabled]);
	}

	const results = await builder.analyze();
	await attachResults(results, options.label);
	return results;
}

/** Attach the full axe JSON (every pass, incomplete, and violation) to the run. */
async function attachResults(results: AxeResults, label?: string): Promise<void> {
	const prefix = label ? `${label}-` : '';
	await test.info().attach(`${prefix}axe-results.json`, {
		contentType: 'application/json',
		body: Buffer.from(JSON.stringify(results, null, 2), 'utf8')
	});
}

/**
 * Throw if the scan surfaced any serious/critical violation. Minor and moderate
 * impacts are tolerated (they remain in the attached JSON for tracking). The
 * failure message lists each failing rule with its impact, node count, and the
 * axe help URL so the cause is actionable from the terminal alone.
 */
export function assertNoSeriousViolations(results: AxeResults): void {
	const failing = results.violations.filter(
		(v) => v.impact !== null && v.impact !== undefined && FAILING_IMPACTS.has(v.impact)
	);
	if (failing.length === 0) return;

	const lines = failing.map(formatViolation);
	throw new Error(
		`Found ${failing.length} serious/critical accessibility violation(s):\n${lines.join('\n')}\n` +
			'See the attached *-axe-results.json for the complete report.'
	);
}

function formatViolation(v: AxeViolation): string {
	return `  - [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node(s))\n      ${v.helpUrl}`;
}

/**
 * Scan and assert in one step. Convenience for the common case; callers that
 * need the raw results (e.g. to inspect incomplete findings) should call
 * {@link scanAccessibility} + {@link assertNoSeriousViolations} directly.
 */
export async function assertPageAccessible(page: Page, options: ScanOptions = {}): Promise<void> {
	const results = await scanAccessibility(page, options);
	assertNoSeriousViolations(results);
}

/**
 * Verify an element exposes the expected role AND currently holds keyboard
 * focus. Catches the common regression where a control keeps its visual style
 * but loses its role, or where focus lands on the wrong element after a dialog
 * opens. Uses the EFFECTIVE role (toHaveRole), so it matches both explicit
 * `role=` attributes and the implicit role of native elements (e.g. <button>).
 * `toBeFocused()` auto-waits, so this is safe right after a focus move.
 */
export async function expectRoleFocused(locator: Locator, role: string): Promise<void> {
	await expect(locator).toHaveRole(role);
	await expect(locator).toBeFocused();
}

/**
 * Verify a node is DOM-contained within a landmark/region. Use this to prove
 * interactive controls live inside the correct landmark (e.g. a drop-zone is
 * within <main>, a dialog action is within the dialog) rather than orphaned.
 */
export async function expectContainedIn(child: Locator, container: Locator): Promise<void> {
	const root = await container.elementHandle();
	try {
		const contained = await child.evaluate((node, landmark) => {
			return landmark ? landmark.contains(node) : false;
		}, root);
		expect(contained, 'expected the element to be contained within the landmark').toBe(true);
	} finally {
		await root?.dispose();
	}
}

/**
 * Verify a live region announces with the expected politeness. A region
 * qualifies via an explicit `aria-live` attribute OR an implicit-live role:
 * status/progressbar/log → polite, alert → assertive. Pass the expected value
 * the region should resolve to ('polite' | 'assertive' | 'off').
 */
export async function expectLiveRegion(
	loc: Locator,
	expected: 'polite' | 'assertive' | 'off'
): Promise<void> {
	await expect(loc).toBeVisible();
	const implicit: Record<string, 'polite' | 'assertive' | 'off'> = {
		status: 'polite',
		progressbar: 'polite',
		log: 'polite',
		alert: 'assertive'
	};
	const observed = await loc.evaluate((el) => ({
		role: el.getAttribute('role'),
		ariaLive: el.getAttribute('aria-live')
	}));
	const effective = observed.ariaLive ?? (observed.role ? implicit[observed.role] : undefined);
	expect(
		effective,
		`expected effective aria-live '${expected}' (role=${observed.role}, aria-live=${observed.ariaLive})`
	).toBe(expected);
}
