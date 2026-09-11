package org.openintegrationengine.plugins.messageflow;

import java.util.ArrayList;
import java.util.Calendar;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import javax.servlet.ServletContext;
import javax.servlet.http.HttpServletRequest;
import javax.ws.rs.core.Context;
import javax.ws.rs.core.MediaType;
import javax.ws.rs.core.Response;
import javax.ws.rs.core.SecurityContext;

import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.mirth.connect.donkey.model.message.ConnectorMessage;
import com.mirth.connect.donkey.model.message.Message;
import com.mirth.connect.model.Channel;
import com.mirth.connect.model.converters.ObjectXMLSerializer;
import com.mirth.connect.model.filters.MessageFilter;
import com.mirth.connect.server.api.MirthServlet;
import com.mirth.connect.server.controllers.ChannelController;
import com.mirth.connect.server.controllers.MessageController;

/**
 * In-process implementation of Message Flow — the renamed, ported version of
 * Mirth DB Explorer's Topology tab. That tool read each channel's exported
 * config XML out of Postgres and regex-scanned it for two kinds of
 * channel-to-channel routing (Channel Writer destinations, and
 * router.routeMessage()/routeMessageByChannelId() script calls) plus every
 * other external destination. Running as a real plugin, we get the exact
 * same export XML directly from the engine's own serializer — no database,
 * no REST hop, no login — via ChannelController + ObjectXMLSerializer.
 *
 * The parsing logic below (parseSourceTransport / parseChannelDestinations /
 * parseScriptRouting / isPositionCommentedOut) is a line-for-line port of
 * that original regex logic; only the source of the XML has changed.
 */
public class MessageFlowServlet extends MirthServlet implements MessageFlowServletInterface {

    private static final Logger LOGGER = LogManager.getLogger(MessageFlowServlet.class);
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static final Pattern SOURCE_CONNECTOR_BLOCK =
        Pattern.compile("<sourceConnector[^>]*>([\\s\\S]*?)</sourceConnector>");
    private static final Pattern DEST_CONNECTORS_BLOCK =
        Pattern.compile("<destinationConnectors[^>]*>([\\s\\S]*?)</destinationConnectors>");
    private static final Pattern CONNECTOR_BLOCK =
        Pattern.compile("<connector[^>]*>([\\s\\S]*?)</connector>");
    private static final Pattern TRANSPORT_NAME = Pattern.compile("<transportName>(.*?)</transportName>");
    private static final Pattern NAME_TAG = Pattern.compile("<name>(.*?)</name>");
    private static final Pattern ENABLED_TAG = Pattern.compile("<enabled>(true|false)</enabled>");
    private static final Pattern CHANNEL_ID_TAG = Pattern.compile("<channelId>(.*?)</channelId>");
    private static final Pattern DYNAMIC_PLACEHOLDER = Pattern.compile("\\$\\{.*\\}");

    // Same quote alternation as the original: real Mirth channel export XML
    // may carry a script's quotes either literally or XML-entity-escaped.
    private static final String QUOTE = "(?:&apos;|'|&quot;|\")";
    private static final Pattern ROUTE_BY_NAME =
        Pattern.compile("router\\.routeMessage\\(\\s*" + QUOTE + "(.*?)" + QUOTE);
    private static final Pattern ROUTE_BY_ID =
        Pattern.compile("router\\.routeMessageByChannelId\\(\\s*" + QUOTE + "(.*?)" + QUOTE);

    public MessageFlowServlet(@Context HttpServletRequest request,
                               @Context ServletContext servletContext,
                               @Context SecurityContext sc) {
        super(request, sc);
        // servletContext isn't needed for anything here -- the constructor
        // still accepts it (rather than dropping the parameter) because this
        // 3-arg shape mirrors WebSupportServlet's own constructor, which is
        // the one real example I could confirm the REST framework
        // instantiates successfully.
    }

    // ── REST operations ──────────────────────────────────────────────────

    @Override
    public Response getTopology() {
        try {
            // ChannelController.getChannels() returns every channel that
            // still exists on the engine, with no awareness of which ones
            // the currently logged-in user is actually allowed to see --
            // that filtering lives in MirthServlet's own redactChannels(),
            // which the raw controller call bypasses entirely. Without
            // this, a user with restricted channel-group visibility would
            // see channels here that don't show up anywhere else they
            // look (confirmed: this is exactly the discrepancy reported --
            // extra channels that persisted through a full engine restart,
            // ruling out a stale cache and pointing at missing
            // authorization filtering instead).
            List<Channel> channels = redactChannels(ChannelController.getInstance().getChannels(null));
            Map<String, Object> result = buildTopology(channels);
            return Response.ok(MAPPER.writeValueAsString(result), MediaType.APPLICATION_JSON).build();
        } catch (Exception e) {
            LOGGER.error("Message Flow: failed to build topology", e);
            Map<String, Object> err = new LinkedHashMap<>();
            err.put("error", e.getMessage());
            String body;
            try {
                body = MAPPER.writeValueAsString(err);
            } catch (Exception e2) {
                body = "{\"error\":\"" + String.valueOf(e.getMessage()).replace("\"", "'") + "\"}";
            }
            return Response.serverError().entity(body).type(MediaType.APPLICATION_JSON).build();
        }
    }

    @Override
    public Response getMessageTrace(String channelId, Long messageId) {
        try {
            if (channelId == null || channelId.isEmpty() || messageId == null) {
                return badRequest("channelId and messageId are both required");
            }

            // Same channel-visibility filtering as getTopology() above --
            // otherwise a trace could surface (or route a scan through) a
            // channel the current user isn't authorized to see.
            List<Channel> channels = redactChannels(ChannelController.getInstance().getChannels(null));
            Map<String, String> idToName = new LinkedHashMap<>();
            for (Channel c : channels) idToName.put(c.getId(), c.getName());

            Message root = MessageController.getInstance().getMessageContent(channelId, messageId, new ArrayList<>());
            if (root == null) {
                Map<String, Object> err = new LinkedHashMap<>();
                err.put("error", "Message " + messageId + " was not found in channel " + (idToName.getOrDefault(channelId, channelId)));
                return Response.status(404).entity(MAPPER.writeValueAsString(err)).type(MediaType.APPLICATION_JSON).build();
            }

            // Same channel-to-channel edges the topology graph uses, so the
            // forward scan only checks channels this one can actually reach.
            Map<String, List<String>> downstreamOf = buildDownstreamAdjacency(channels);

            List<Map<String, Object>> ancestors = traceAncestors(root, idToName);

            List<Map<String, Object>> descendants = new ArrayList<>();
            Set<String> visited = new HashSet<>();
            visited.add(channelId + ":" + messageId);
            traceDescendants(channelId, messageId, root.getReceivedDate(), downstreamOf, idToName, descendants, visited, 0);

            Map<String, Object> result = new LinkedHashMap<>();
            result.put("channelId", channelId);
            result.put("channelName", idToName.get(channelId));
            result.put("messageId", messageId);
            result.put("ancestors", ancestors);
            result.put("descendants", descendants);
            return Response.ok(MAPPER.writeValueAsString(result), MediaType.APPLICATION_JSON).build();
        } catch (Exception e) {
            LOGGER.error("Message Flow: failed to trace message " + messageId + " in channel " + channelId, e);
            Map<String, Object> err = new LinkedHashMap<>();
            err.put("error", e.getMessage());
            String body;
            try {
                body = MAPPER.writeValueAsString(err);
            } catch (Exception e2) {
                body = "{\"error\":\"" + String.valueOf(e.getMessage()).replace("\"", "'") + "\"}";
            }
            return Response.serverError().entity(body).type(MediaType.APPLICATION_JSON).build();
        }
    }

    private Response badRequest(String message) {
        Map<String, Object> err = new LinkedHashMap<>();
        err.put("error", message);
        String body;
        try {
            body = MAPPER.writeValueAsString(err);
        } catch (Exception e) {
            body = "{\"error\":\"" + message.replace("\"", "'") + "\"}";
        }
        return Response.status(400).entity(body).type(MediaType.APPLICATION_JSON).build();
    }

    // ── message trace: ancestors (free -- already on the message's own Source Map) ──

    // Mirth writes BOTH the immediate parent (singular sourceChannelId/
    // sourceMessageId) AND the accumulated full chain (plural
    // sourceChannelIds/sourceMessageIds) into a routed message's source
    // connector's Source Map. Prefer the plural chain (it's the complete
    // upstream lineage in one read, oldest-first); fall back to the
    // singular pair for a message that's only ever been routed once.
    private List<Map<String, Object>> traceAncestors(Message root, Map<String, String> idToName) {
        List<Map<String, Object>> out = new ArrayList<>();
        ConnectorMessage source = root.getConnectorMessages() != null ? root.getConnectorMessages().get(0) : null;
        if (source == null) return out;
        Map<String, Object> sourceMap = source.getSourceMap();
        if (sourceMap == null) return out;

        List<String> chainChannelIds = asStringList(sourceMap.get("sourceChannelIds"));
        List<Long> chainMessageIds = asLongList(sourceMap.get("sourceMessageIds"));
        if (chainChannelIds.isEmpty() || chainMessageIds.isEmpty()) {
            Object singleChan = sourceMap.get("sourceChannelId");
            Object singleMsg = sourceMap.get("sourceMessageId");
            Long singleMsgLong = asLong(singleMsg);
            if (singleChan != null && singleMsgLong != null) {
                chainChannelIds = Collections.singletonList(String.valueOf(singleChan));
                chainMessageIds = Collections.singletonList(singleMsgLong);
            }
        }

        int n = Math.min(chainChannelIds.size(), chainMessageIds.size());
        for (int i = 0; i < n; i++) {
            Map<String, Object> hop = summarizeMessage(chainChannelIds.get(i), chainMessageIds.get(i), idToName);
            hop.put("hop", -(n - i));
            out.add(hop);
        }
        return out;
    }

    // ── message trace: descendants (bounded forward scan -- no server-side ──
    // ── index exists for "find the message that came from this one") ────────

    private static final int MAX_TRACE_DEPTH = 5;
    // Lower than before (was 200): each candidate now costs one extra
    // getMessageContent() round trip (see below), so this bounds real cost
    // per channel per hop rather than just result-list size.
    private static final int FORWARD_SCAN_LIMIT = 50;

    private void traceDescendants(String channelId, Long messageId, Calendar notBefore,
            Map<String, List<String>> downstreamOf, Map<String, String> idToName,
            List<Map<String, Object>> out, Set<String> visited, int depth) {
        if (depth >= MAX_TRACE_DEPTH) return;
        List<String> candidates = downstreamOf.get(channelId);
        if (candidates == null || candidates.isEmpty()) return;

        for (String candidateChannelId : candidates) {
            List<Message> candidateMessages;
            try {
                MessageFilter filter = new MessageFilter();
                if (notBefore != null) filter.setStartDate(notBefore);
                candidateMessages = MessageController.getInstance().getMessages(filter, candidateChannelId, Boolean.FALSE, 0, FORWARD_SCAN_LIMIT);
            } catch (Exception e) {
                LOGGER.warn("Message Flow: could not scan channel " + candidateChannelId + " for descendants of " + channelId + ":" + messageId, e);
                continue;
            }
            if (candidateMessages == null) continue;

            for (Message summary : candidateMessages) {
                // getMessages() (search) most likely returns lightweight
                // summaries for grid display, not full connector-message
                // content -- the earlier bug report (ancestors always
                // worked, descendants never found anything, even for a
                // known-real chain) matches that exactly: every candidate's
                // Source Map was silently null. Re-fetch full content
                // explicitly via the same call ancestor-tracing already
                // uses successfully, rather than trusting the search
                // result already has it.
                Long candidateMessageId = summary.getMessageId();
                Message candidate;
                try {
                    candidate = MessageController.getInstance().getMessageContent(candidateChannelId, candidateMessageId, new ArrayList<>());
                } catch (Exception e) {
                    continue;
                }
                if (candidate == null) continue;

                ConnectorMessage src = candidate.getConnectorMessages() != null ? candidate.getConnectorMessages().get(0) : null;
                if (src == null) continue;
                Map<String, Object> sm = src.getSourceMap();
                if (sm == null || !matchesAncestor(sm, channelId, messageId)) continue;

                String key = candidateChannelId + ":" + candidateMessageId;
                if (!visited.add(key)) continue; // already recorded via a different candidate path

                Map<String, Object> hit = summarizeMessage(candidateChannelId, candidateMessageId, idToName);
                hit.put("hop", depth + 1);
                out.add(hit);

                traceDescendants(candidateChannelId, candidateMessageId, candidate.getReceivedDate(),
                    downstreamOf, idToName, out, visited, depth + 1);
            }
        }
    }

    private boolean matchesAncestor(Map<String, Object> sourceMap, String channelId, Long messageId) {
        Object singleChan = sourceMap.get("sourceChannelId");
        Long singleMsg = asLong(sourceMap.get("sourceMessageId"));
        if (channelId.equals(String.valueOf(singleChan)) && messageId.equals(singleMsg)) return true;

        List<String> chainChannelIds = asStringList(sourceMap.get("sourceChannelIds"));
        List<Long> chainMessageIds = asLongList(sourceMap.get("sourceMessageIds"));
        int n = Math.min(chainChannelIds.size(), chainMessageIds.size());
        for (int i = 0; i < n; i++) {
            if (channelId.equals(chainChannelIds.get(i)) && messageId.equals(chainMessageIds.get(i))) return true;
        }
        return false;
    }

    // Builds the same channel-to-channel adjacency the topology graph uses
    // (Channel Writer destinations + router.routeMessage()/
    // routeMessageByChannelId() script calls), as fromId -> [toId, ...].
    // Recomputed here from a fresh ObjectXMLSerializer pass rather than
    // shared with buildTopology()'s own pass -- a second parse of modest,
    // already-in-memory channel XML is cheap, and keeping this self
    // contained avoids coupling the trace path's shape to the topology
    // response's shape.
    private Map<String, List<String>> buildDownstreamAdjacency(List<Channel> channels) {
        Map<String, List<String>> adjacency = new LinkedHashMap<>();
        Map<String, String> nameToId = new LinkedHashMap<>();
        for (Channel c : channels) nameToId.put(c.getName(), c.getId());

        ObjectXMLSerializer serializer = ObjectXMLSerializer.getInstance();
        for (Channel c : channels) {
            String xml;
            try {
                xml = serializer.serialize(c);
            } catch (Exception e) {
                continue;
            }
            for (Destination d : parseChannelDestinations(xml)) {
                if (d.targetChannelId != null) {
                    adjacency.computeIfAbsent(c.getId(), k -> new ArrayList<>()).add(d.targetChannelId);
                }
            }
            for (ScriptRoute r : parseScriptRouting(xml)) {
                String toId = "routeMessageByChannelId".equals(r.method) ? r.value : nameToId.get(r.value);
                if (toId != null) {
                    adjacency.computeIfAbsent(c.getId(), k -> new ArrayList<>()).add(toId);
                }
            }
        }
        return adjacency;
    }

    // Fetches just enough about one message to display it in a trace: status
    // and received time, from its own source connector message.
    private Map<String, Object> summarizeMessage(String channelId, Long messageId, Map<String, String> idToName) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("channelId", channelId);
        m.put("channelName", idToName.get(channelId));
        m.put("messageId", messageId);
        try {
            Message msg = MessageController.getInstance().getMessageContent(channelId, messageId, new ArrayList<>());
            if (msg != null) {
                ConnectorMessage src = msg.getConnectorMessages() != null ? msg.getConnectorMessages().get(0) : null;
                m.put("status", src != null && src.getStatus() != null ? src.getStatus().toString() : null);
                m.put("receivedDate", msg.getReceivedDate() != null ? msg.getReceivedDate().getTimeInMillis() : null);
            } else {
                m.put("status", null);
                m.put("receivedDate", null);
                m.put("notFound", true);
            }
        } catch (Exception e) {
            m.put("status", null);
            m.put("lookupError", e.getMessage());
        }
        return m;
    }

    @SuppressWarnings("unchecked")
    private List<String> asStringList(Object v) {
        if (v == null) return Collections.emptyList();
        if (v instanceof List) {
            List<String> out = new ArrayList<>();
            for (Object o : (List<Object>) v) out.add(String.valueOf(o));
            return out;
        }
        return Collections.singletonList(String.valueOf(v));
    }

    @SuppressWarnings("unchecked")
    private List<Long> asLongList(Object v) {
        if (v == null) return Collections.emptyList();
        if (v instanceof List) {
            List<Long> out = new ArrayList<>();
            for (Object o : (List<Object>) v) {
                Long l = asLong(o);
                if (l != null) out.add(l);
            }
            return out;
        }
        Long l = asLong(v);
        return l != null ? Collections.singletonList(l) : Collections.emptyList();
    }

    private Long asLong(Object v) {
        if (v == null) return null;
        if (v instanceof Number) return ((Number) v).longValue();
        try {
            return Long.parseLong(String.valueOf(v));
        } catch (Exception e) {
            return null;
        }
    }

    // ── topology construction (ported from Mirth DB Explorer's Topology tab) ──

    private Map<String, Object> buildTopology(List<Channel> channels) {
        Map<String, String> idToName = new LinkedHashMap<>();
        Map<String, String> nameToId = new LinkedHashMap<>();
        for (Channel c : channels) {
            idToName.put(c.getId(), c.getName());
            nameToId.put(c.getName(), c.getId());
        }

        List<Map<String, Object>> nodes = new ArrayList<>();
        List<Map<String, Object>> edges = new ArrayList<>();
        List<Map<String, Object>> externalDestinations = new ArrayList<>();
        int unconfiguredCount = 0;

        ObjectXMLSerializer serializer = ObjectXMLSerializer.getInstance();

        for (Channel c : channels) {
            String xml;
            try {
                xml = serializer.serialize(c);
            } catch (Exception e) {
                LOGGER.warn("Message Flow: could not serialize channel " + c.getName() + " (" + c.getId() + ") — skipping its routing", e);
                Map<String, Object> node = new LinkedHashMap<>();
                node.put("id", c.getId());
                node.put("name", c.getName());
                node.put("sourceTransport", null);
                nodes.add(node);
                continue;
            }

            Map<String, Object> node = new LinkedHashMap<>();
            node.put("id", c.getId());
            node.put("name", c.getName());
            node.put("sourceTransport", parseSourceTransport(xml));
            nodes.add(node);

            for (Destination d : parseChannelDestinations(xml)) {
                if (d.unconfigured) {
                    unconfiguredCount++;
                    continue;
                }
                if (d.targetChannelId != null) {
                    Map<String, Object> edge = new LinkedHashMap<>();
                    edge.put("fromId", c.getId());
                    edge.put("fromName", c.getName());
                    edge.put("toId", d.targetChannelId);
                    edge.put("toName", idToName.get(d.targetChannelId));
                    edge.put("destName", d.name);
                    edge.put("enabled", d.enabled);
                    edges.add(edge);
                } else if (d.transportName != null) {
                    Map<String, Object> ext = new LinkedHashMap<>();
                    ext.put("channelId", c.getId());
                    ext.put("channelName", c.getName());
                    ext.put("destName", d.name);
                    ext.put("transportName", d.transportName);
                    ext.put("enabled", d.enabled);
                    ext.put("dynamicRouting", d.dynamicRouting);
                    externalDestinations.add(ext);
                }
            }

            for (ScriptRoute r : parseScriptRouting(xml)) {
                String toId = "routeMessageByChannelId".equals(r.method) ? r.value : nameToId.get(r.value);
                Map<String, Object> edge = new LinkedHashMap<>();
                edge.put("fromId", c.getId());
                edge.put("fromName", c.getName());
                edge.put("toId", toId);
                edge.put("toName", toId != null ? idToName.get(toId) : r.value);
                edge.put("destName", "Script: " + r.method + "('" + r.value + "')");
                edge.put("enabled", null); // unknown — may be conditional inside the script
                edge.put("viaScript", true);
                edges.add(edge);
            }
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("nodes", nodes);
        result.put("edges", edges);
        result.put("externalDestinations", externalDestinations);
        result.put("unconfiguredCount", unconfiguredCount);
        return result;
    }

    /** Every channel has exactly one source connector; its transportName is what kind of interface this channel is. */
    private static String parseSourceTransport(String channelXml) {
        if (channelXml == null) return null;
        Matcher srcBlock = SOURCE_CONNECTOR_BLOCK.matcher(channelXml);
        if (!srcBlock.find()) return null;
        Matcher transport = TRANSPORT_NAME.matcher(srcBlock.group(1));
        return transport.find() ? transport.group(1) : null;
    }

    private static final class Destination {
        String name;
        String transportName;
        boolean enabled;
        String targetChannelId; // non-null only for a configured, non-dynamic Channel Writer
        boolean dynamicRouting;
        boolean unconfigured;
    }

    private static List<Destination> parseChannelDestinations(String channelXml) {
        List<Destination> destinations = new ArrayList<>();
        if (channelXml == null) return destinations;
        Matcher destBlockMatcher = DEST_CONNECTORS_BLOCK.matcher(channelXml);
        if (!destBlockMatcher.find()) return destinations;
        String destBlock = destBlockMatcher.group(1);

        Matcher connectorMatcher = CONNECTOR_BLOCK.matcher(destBlock);
        while (connectorMatcher.find()) {
            String block = connectorMatcher.group(1);

            Matcher nameMatcher = NAME_TAG.matcher(block);
            String name = nameMatcher.find() ? nameMatcher.group(1) : null;

            Matcher transportMatcher = TRANSPORT_NAME.matcher(block);
            String transportName = transportMatcher.find() ? transportMatcher.group(1) : null;

            // <enabled> appears once per transformer step and once for the
            // connector itself — the one we want is the LAST match in the block.
            Matcher enabledMatcher = ENABLED_TAG.matcher(block);
            String enabledLast = null;
            while (enabledMatcher.find()) {
                enabledLast = enabledMatcher.group(1);
            }

            Matcher channelIdMatcher = CHANNEL_ID_TAG.matcher(block);
            String rawChannelId = channelIdMatcher.find() ? channelIdMatcher.group(1).trim() : "";

            boolean isChannelWriter = "Channel Writer".equals(transportName);
            boolean isUnconfigured = isChannelWriter && (rawChannelId.isEmpty() || "none".equalsIgnoreCase(rawChannelId));
            boolean isDynamic = isChannelWriter && DYNAMIC_PLACEHOLDER.matcher(rawChannelId).find();

            Destination d = new Destination();
            d.name = name != null ? name : "(unnamed destination)";
            d.transportName = transportName;
            d.enabled = enabledLast == null || "true".equals(enabledLast);
            d.targetChannelId = (isChannelWriter && !isUnconfigured && !isDynamic) ? rawChannelId : null;
            d.dynamicRouting = isDynamic;
            d.unconfigured = isUnconfigured;
            destinations.add(d);
        }
        return destinations;
    }

    private static final class ScriptRoute {
        String method; // "routeMessage" | "routeMessageByChannelId"
        String value;
    }

    // Best-effort check for whether a matched position sits inside a JS
    // comment (// line comment or /* block */) -- tracks string-literal
    // state (including XML-entity-escaped quotes, since scripts arrive
    // here as XML text content) while scanning, so a // or /* that's just
    // ordinary text inside a string (a logged URL, a note like "see
    // ticket #123 // fixed later") can never be mistaken for a real
    // comment marker, and a real comment marker that happens to fall
    // inside a string is correctly ignored either way. Not a full JS
    // tokenizer (template literals and regex literals aren't specially
    // handled), but covers the case that actually produced wrong results:
    // a route call being silently dropped because unrelated text earlier
    // in the same script merely looked like a comment opener.
    private static boolean isPositionCommentedOut(String text, int pos) {
        boolean inLineComment = false;
        boolean inBlockComment = false;
        boolean inSingleQuote = false;
        boolean inDoubleQuote = false;

        int i = 0;
        while (i < pos) {
            if (inLineComment) {
                if (text.charAt(i) == '\n') inLineComment = false;
                i++;
                continue;
            }
            if (inBlockComment) {
                if (regionMatches(text, i, "*/")) { inBlockComment = false; i += 2; }
                else i++;
                continue;
            }
            if (inSingleQuote) {
                if (regionMatches(text, i, "&apos;")) { inSingleQuote = false; i += 6; }
                else if (text.charAt(i) == '\\' && i + 1 < text.length()) { i += 2; }
                else if (text.charAt(i) == '\'') { inSingleQuote = false; i++; }
                else i++;
                continue;
            }
            if (inDoubleQuote) {
                if (regionMatches(text, i, "&quot;")) { inDoubleQuote = false; i += 6; }
                else if (text.charAt(i) == '\\' && i + 1 < text.length()) { i += 2; }
                else if (text.charAt(i) == '"') { inDoubleQuote = false; i++; }
                else i++;
                continue;
            }
            // Not currently inside any comment or string -- check what starts here.
            if (regionMatches(text, i, "//")) { inLineComment = true; i += 2; continue; }
            if (regionMatches(text, i, "/*")) { inBlockComment = true; i += 2; continue; }
            if (regionMatches(text, i, "&apos;")) { inSingleQuote = true; i += 6; continue; }
            if (regionMatches(text, i, "&quot;")) { inDoubleQuote = true; i += 6; continue; }
            if (text.charAt(i) == '\'') { inSingleQuote = true; i++; continue; }
            if (text.charAt(i) == '"') { inDoubleQuote = true; i++; continue; }
            i++;
        }
        return inLineComment || inBlockComment;
    }

    private static boolean regionMatches(String text, int pos, String needle) {
        return text.regionMatches(pos, needle, 0, needle.length());
    }

    private static List<ScriptRoute> parseScriptRouting(String channelXml) {
        List<ScriptRoute> calls = new ArrayList<>();
        if (channelXml == null) return calls;

        Matcher byName = ROUTE_BY_NAME.matcher(channelXml);
        while (byName.find()) {
            if (isPositionCommentedOut(channelXml, byName.start())) continue;
            ScriptRoute r = new ScriptRoute();
            r.method = "routeMessage";
            r.value = byName.group(1);
            calls.add(r);
        }

        Matcher byId = ROUTE_BY_ID.matcher(channelXml);
        while (byId.find()) {
            if (isPositionCommentedOut(channelXml, byId.start())) continue;
            ScriptRoute r = new ScriptRoute();
            r.method = "routeMessageByChannelId";
            r.value = byId.group(1);
            calls.add(r);
        }

        return calls;
    }
}
