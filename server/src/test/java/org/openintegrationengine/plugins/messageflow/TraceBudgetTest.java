// SPDX-FileCopyrightText: Copyright 2026 Synthesis Health
// SPDX-FileCopyrightText: Copyright 2026 Keith Smith
// SPDX-License-Identifier: MPL-2.0

package org.openintegrationengine.plugins.messageflow;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;
import org.openintegrationengine.plugins.messageflow.MessageFlowServlet.TraceBudget;

/**
 * The ceiling that stops one trace request from becoming thousands of reads
 * against the message store. Depth and per-channel limits do not bound the
 * total on their own, because the descendant walk recurses per match.
 */
class TraceBudgetTest {

    /** Mirrors MessageFlowServlet.MAX_TRACE_LOOKUPS. */
    private static final int CEILING = 500;

    @Test
    void allowsReadsUpToTheCeiling() {
        TraceBudget budget = new TraceBudget();
        for (int i = 0; i < CEILING; i++) {
            assertTrue(budget.take(), "read " + (i + 1) + " should be allowed");
        }
        assertFalse(budget.take(), "the read past the ceiling must be refused");
    }

    /**
     * The distinction that matters to the UI: a trace that finishes using its
     * last permitted read is complete, not cut short. Reporting truncated there
     * tells the user their chain may be incomplete when it isn't.
     */
    @Test
    void finishingExactlyAtTheCeilingIsNotTruncated() {
        TraceBudget budget = new TraceBudget();
        for (int i = 0; i < CEILING; i++) budget.take();

        assertTrue(budget.spent(), "no capacity should remain");
        assertFalse(budget.truncated, "nothing was refused, so nothing was cut short");
    }

    @Test
    void aRefusedReadMarksTheTraceTruncated() {
        TraceBudget budget = new TraceBudget();
        for (int i = 0; i < CEILING; i++) budget.take();
        budget.take();

        assertTrue(budget.truncated);
    }

    /** Asking whether capacity remains must not itself mark the trace cut short. */
    @Test
    void askingWhetherCapacityRemainsDoesNotSetTruncated() {
        TraceBudget budget = new TraceBudget();
        for (int i = 0; i < CEILING; i++) budget.take();

        assertTrue(budget.spent());
        assertTrue(budget.spent());
        assertFalse(budget.truncated);
    }

    @Test
    void aFreshBudgetIsNeitherSpentNorTruncated() {
        TraceBudget budget = new TraceBudget();
        assertFalse(budget.spent());
        assertFalse(budget.truncated);
    }
}
