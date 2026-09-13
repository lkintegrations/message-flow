// SPDX-FileCopyrightText: Copyright 2026 Synthesis Health
// SPDX-FileCopyrightText: Copyright 2026 Keith Smith
// SPDX-License-Identifier: MPL-2.0

package org.openintegrationengine.plugins.messageflow;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Arrays;
import java.util.List;

import org.junit.jupiter.api.Test;
import org.openintegrationengine.plugins.messageflow.MessageFlowServlet.Destination;
import org.openintegrationengine.plugins.messageflow.MessageFlowServlet.ScriptRoute;

/**
 * Covers the routing parsers, which read channel export XML with regular
 * expressions rather than walking the model objects. That is where a wrong
 * answer is both most likely and least visible: a missed route just quietly
 * fails to draw an edge.
 *
 * Not covered here: anything reaching ChannelController, MessageController or
 * MirthServlet.redactChannels(), which need a running engine. The authorization
 * behaviour in getMessageTrace() in particular is unit-untested and has to be
 * checked against a real engine with a restricted user.
 */
class MessageFlowParsingTest {

    private static String channel(String sourceTransport, String destinationsXml) {
        return "<channel><sourceConnector><transportName>" + sourceTransport + "</transportName></sourceConnector>"
            + "<destinationConnectors>" + destinationsXml + "</destinationConnectors></channel>";
    }

    private static String destination(String name, String transport, String body) {
        return "<connector><name>" + name + "</name><transportName>" + transport + "</transportName>" + body + "</connector>";
    }

    // ── source transport ─────────────────────────────────────────────────

    @Test
    void readsSourceTransport() {
        assertEquals("TCP Listener", MessageFlowServlet.parseSourceTransport(channel("TCP Listener", "")));
    }

    @Test
    void missingSourceConnectorIsNullNotAnError() {
        assertNull(MessageFlowServlet.parseSourceTransport("<channel></channel>"));
        assertNull(MessageFlowServlet.parseSourceTransport(null));
    }

    // ── channel destinations ─────────────────────────────────────────────

    @Test
    void channelWriterYieldsRoutingTarget() {
        List<Destination> destinations = MessageFlowServlet.parseChannelDestinations(
            channel("TCP Listener", destination("Billing", "Channel Writer", "<channelId>abc-123</channelId><enabled>true</enabled>")));

        assertEquals(1, destinations.size());
        assertEquals("abc-123", destinations.get(0).targetChannelId);
        assertTrue(destinations.get(0).enabled);
        assertFalse(destinations.get(0).unconfigured);
    }

    @Test
    void externalDestinationHasNoTargetChannel() {
        List<Destination> destinations = MessageFlowServlet.parseChannelDestinations(
            channel("TCP Listener", destination("Vendor", "TCP Sender", "<enabled>true</enabled>")));

        assertNull(destinations.get(0).targetChannelId);
        assertEquals("TCP Sender", destinations.get(0).transportName);
    }

    @Test
    void unconfiguredChannelWriterIsFlaggedNotRouted() {
        for (String raw : new String[] { "", "none", "NONE" }) {
            List<Destination> destinations = MessageFlowServlet.parseChannelDestinations(
                channel("TCP Listener", destination("Stub", "Channel Writer", "<channelId>" + raw + "</channelId>")));
            assertTrue(destinations.get(0).unconfigured, "channelId '" + raw + "' should read as unconfigured");
            assertNull(destinations.get(0).targetChannelId);
        }
    }

    /** The template names what decides the target, which is more use to a
        reader than being told only that something does. */
    @Test
    void dynamicChannelWriterKeepsItsTemplate() {
        List<Destination> destinations = MessageFlowServlet.parseChannelDestinations(
            channel("TCP Listener", destination("Site", "Channel Writer", "<channelId>${targetChannel}</channelId>")));

        assertTrue(destinations.get(0).dynamicRouting);
        assertEquals("${targetChannel}", destinations.get(0).rawTarget);
    }

    @Test
    void dynamicChannelWriterTargetIsNotResolved() {
        List<Destination> destinations = MessageFlowServlet.parseChannelDestinations(
            channel("TCP Listener", destination("Dynamic", "Channel Writer", "<channelId>${targetChannel}</channelId>")));

        assertTrue(destinations.get(0).dynamicRouting);
        assertNull(destinations.get(0).targetChannelId);
        assertFalse(destinations.get(0).unconfigured);
    }

    /**
     * <enabled> appears once per transformer step as well as once for the
     * connector, and only the connector's own value decides whether the
     * destination runs. The parser takes the last match in the block, so a
     * disabled transformer step ahead of an enabled connector must not win.
     */
    @Test
    void connectorEnabledWinsOverTransformerStepEnabled() {
        List<Destination> destinations = MessageFlowServlet.parseChannelDestinations(
            channel("TCP Listener", destination("Billing", "Channel Writer",
                "<transformer><step><enabled>false</enabled></step></transformer>"
                    + "<channelId>abc-123</channelId><enabled>true</enabled>")));

        assertTrue(destinations.get(0).enabled);
    }

    @Test
    void disabledDestinationIsReportedDisabled() {
        List<Destination> destinations = MessageFlowServlet.parseChannelDestinations(
            channel("TCP Listener", destination("Off", "Channel Writer", "<channelId>abc-123</channelId><enabled>false</enabled>")));

        assertFalse(destinations.get(0).enabled);
        assertEquals("abc-123", destinations.get(0).targetChannelId, "a disabled route is still a route");
    }

    @Test
    void unnamedDestinationGetsAPlaceholderName() {
        List<Destination> destinations = MessageFlowServlet.parseChannelDestinations(
            channel("TCP Listener", "<connector><transportName>Channel Writer</transportName><channelId>abc</channelId></connector>"));

        assertEquals("(unnamed destination)", destinations.get(0).name);
    }

    @Test
    void noDestinationBlockYieldsNothing() {
        assertTrue(MessageFlowServlet.parseChannelDestinations("<channel></channel>").isEmpty());
        assertTrue(MessageFlowServlet.parseChannelDestinations(null).isEmpty());
    }

    // ── script routing ───────────────────────────────────────────────────

    @Test
    void findsBothRoutingCallsWithPlainQuotes() {
        List<ScriptRoute> routes = MessageFlowServlet.parseScriptRouting(
            "<script>router.routeMessage('Billing Feed', msg); router.routeMessageByChannelId(\"abc-123\", msg);</script>");

        assertEquals(2, routes.size());
        assertEquals("routeMessage", routes.get(0).method);
        assertEquals("Billing Feed", routes.get(0).value);
        assertEquals("routeMessageByChannelId", routes.get(1).method);
        assertEquals("abc-123", routes.get(1).value);
    }

    /** Channel export XML may carry a script's quotes entity-escaped. */
    @Test
    void findsRoutingCallsWithEntityEscapedQuotes() {
        List<ScriptRoute> routes = MessageFlowServlet.parseScriptRouting(
            "<script>router.routeMessage(&apos;Billing Feed&apos;, msg);</script>");

        assertEquals(1, routes.size());
        assertEquals("Billing Feed", routes.get(0).value);
    }

    @Test
    void ignoresRoutingCallsInLineComments() {
        assertTrue(MessageFlowServlet.parseScriptRouting(
            "<script>// router.routeMessage('Old Feed', msg);\n</script>").isEmpty());
    }

    @Test
    void ignoresRoutingCallsInBlockComments() {
        assertTrue(MessageFlowServlet.parseScriptRouting(
            "<script>/* router.routeMessage('Old Feed', msg); */</script>").isEmpty());
    }

    @Test
    void aCommentAfterARealCallDoesNotSuppressIt() {
        List<ScriptRoute> routes = MessageFlowServlet.parseScriptRouting(
            "<script>router.routeMessage('Live', msg); // router.routeMessage('Dead', msg);\n</script>");

        assertEquals(1, routes.size());
        assertEquals("Live", routes.get(0).value);
    }

    @Test
    void noRoutingCallsYieldsEmpty() {
        assertTrue(MessageFlowServlet.parseScriptRouting("<script>var x = 1;</script>").isEmpty());
        assertTrue(MessageFlowServlet.parseScriptRouting(null).isEmpty());
    }

    // ── the Route with Sources convention ────────────────────────────────

    /**
     * The library's functions are called bare, without the "router." prefix.
     * Matching only the prefixed form missed every call made through it, so a
     * channel following the traceable convention drew no edges at all: the
     * channels doing the right thing looked like dead ends.
     */
    @Test
    void findsLibraryRouteCalls() {
        List<ScriptRoute> routes = MessageFlowServlet.parseScriptRouting(
            "<script>routeMessage('ADT Processor', connectorMessage.getRawData());</script>");

        assertEquals(1, routes.size());
        assertEquals("routeMessage", routes.get(0).method);
        assertEquals("ADT Processor", routes.get(0).value);
        assertTrue(routes.get(0).traced, "a library call records lineage");
    }

    @Test
    void findsLibraryRouteByChannelIdCalls() {
        List<ScriptRoute> routes = MessageFlowServlet.parseScriptRouting(
            "<script>routeMessageByChannelId('abc-123', msg);</script>");

        assertEquals(1, routes.size());
        assertEquals("routeMessageByChannelId", routes.get(0).method);
        assertTrue(routes.get(0).traced);
    }

    @Test
    void bareRouterCallsAreNotTraced() {
        List<ScriptRoute> routes = MessageFlowServlet.parseScriptRouting(
            "<script>router.routeMessage('Billing Feed', msg);</script>");

        assertEquals(1, routes.size());
        assertFalse(routes.get(0).traced, "router.routeMessage records no lineage");
    }

    /**
     * The lookbehind earning its keep: router.routeMessage('X') must produce
     * exactly one route, not one prefixed plus one bare.
     */
    @Test
    void aRouterCallIsNotAlsoCountedAsALibraryCall() {
        List<ScriptRoute> routes = MessageFlowServlet.parseScriptRouting(
            "<script>router.routeMessage('Billing Feed', msg);</script>");

        assertEquals(1, routes.size(), "the prefixed call must not match the bare pattern as well");
    }

    @Test
    void tracedAndUntracedCallsInOneChannelAreBothFound() {
        List<ScriptRoute> routes = MessageFlowServlet.parseScriptRouting(
            "<script>routeMessage('Good', msg); router.routeMessage('Bad', msg);</script>");

        assertEquals(2, routes.size());
        assertEquals(1, routes.stream().filter((r) -> r.traced).count());
        assertEquals("Good", routes.stream().filter((r) -> r.traced).findFirst().get().value);
        assertEquals("Bad", routes.stream().filter((r) -> !r.traced).findFirst().get().value);
    }

    /** The library's own wrapper body would otherwise read as a channel route. */
    @Test
    void createRawMessageIsNotMistakenForARoute() {
        assertTrue(MessageFlowServlet.parseScriptRouting(
            "<script>var m = createRawMessage('payload', null);</script>").isEmpty());
    }

    @Test
    void destinationsCarryTheirMetaDataId() {
        List<Destination> destinations = MessageFlowServlet.parseChannelDestinations(
            "<channel><destinationConnectors><connector><metaDataId>2</metaDataId><name>Billing</name>"
                + "<transportName>Channel Writer</transportName><channelId>abc</channelId></connector>"
                + "</destinationConnectors></channel>");

        assertEquals(Integer.valueOf(2), destinations.get(0).metaDataId,
            "the editor numbers destinations by metaDataId, so that is how a route should be located");
    }

    // ── comment detection ────────────────────────────────────────────────

    @Test
    void positionInsideLineCommentIsCommented() {
        String text = "// disabled\nrun();";
        assertTrue(MessageFlowServlet.isPositionCommentedOut(text, text.indexOf("disabled")));
    }

    @Test
    void lineCommentEndsAtNewline() {
        String text = "// disabled\nrun();";
        assertFalse(MessageFlowServlet.isPositionCommentedOut(text, text.indexOf("run")));
    }

    @Test
    void positionInsideBlockCommentIsCommented() {
        String text = "/* off */ run();";
        assertTrue(MessageFlowServlet.isPositionCommentedOut(text, text.indexOf("off")));
        assertFalse(MessageFlowServlet.isPositionCommentedOut(text, text.indexOf("run")));
    }

    /**
     * The failure this guard exists for: a // inside an ordinary string, such
     * as a logged URL, previously read as a comment opener and silently
     * dropped every routing call after it.
     */
    @Test
    void slashesInsideAStringAreNotACommentOpener() {
        String text = "log('https://example.org'); run();";
        assertFalse(MessageFlowServlet.isPositionCommentedOut(text, text.indexOf("run")));
    }

    @Test
    void commentMarkerInsideAStringIsIgnored() {
        String text = "log('see ticket #123 /* note */'); run();";
        assertFalse(MessageFlowServlet.isPositionCommentedOut(text, text.indexOf("run")));
    }

    @Test
    void entityEscapedStringsTrackTheSameWay() {
        String text = "log(&apos;https://example.org&apos;); run();";
        assertFalse(MessageFlowServlet.isPositionCommentedOut(text, text.indexOf("run")));
    }

    @Test
    void escapedQuoteDoesNotEndTheString() {
        String text = "log('it\\'s // fine'); run();";
        assertFalse(MessageFlowServlet.isPositionCommentedOut(text, text.indexOf("run")));
    }

    // ── source map coercion ──────────────────────────────────────────────

    @Test
    void stringListAcceptsListsAndBareValues() {
        assertEquals(Arrays.asList("a", "b"), MessageFlowServlet.asStringList(Arrays.asList("a", "b")));
        assertEquals(Arrays.asList("a"), MessageFlowServlet.asStringList("a"));
        assertTrue(MessageFlowServlet.asStringList(null).isEmpty());
    }

    @Test
    void longListAcceptsNumbersAndNumericStrings() {
        assertEquals(Arrays.asList(1L, 2L), MessageFlowServlet.asLongList(Arrays.asList(1, "2")));
        assertEquals(Arrays.asList(7L), MessageFlowServlet.asLongList(7L));
        assertTrue(MessageFlowServlet.asLongList(null).isEmpty());
    }

    /**
     * A Source Map value that is not a number is dropped rather than throwing:
     * the map is free-form and a channel can write anything into it.
     */
    @Test
    void unparseableMessageIdsAreDropped() {
        assertEquals(Arrays.asList(1L), MessageFlowServlet.asLongList(Arrays.asList(1, "not-a-number")));
        assertTrue(MessageFlowServlet.asLongList("not-a-number").isEmpty());
        assertNull(MessageFlowServlet.asLong("not-a-number"));
    }
}
