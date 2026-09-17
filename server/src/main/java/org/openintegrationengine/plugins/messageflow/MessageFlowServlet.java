package org.openintegrationengine.plugins.messageflow;

import java.util.ArrayList;
import java.util.Calendar;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
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
import com.mirth.connect.model.ChannelProperties;
import com.mirth.connect.model.MessageStorageMode;
import com.mirth.connect.model.converters.ObjectXMLSerializer;
import com.mirth.connect.model.filters.MessageFilter;
import com.mirth.connect.server.api.MirthServlet;
import com.mirth.connect.server.controllers.ChannelController;
import com.mirth.connect.server.controllers.MessageController;

/**
 * Builds the channel routing graph and traces a single message's lineage.
 *
 * The topology is read out of each channel's export XML with regular
 * expressions rather than by walking the model objects. See
 * docs/design-notes.md for why.
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
    private static final Pattern METADATA_ID_TAG = Pattern.compile("<metaDataId>(\\d+)</metaDataId>");
    private static final Pattern DYNAMIC_PLACEHOLDER = Pattern.compile("\\$\\{.*\\}");

    // Channel export XML may carry a script's quotes literally or
    // entity-escaped, so both forms have to match.
    private static final String QUOTE = "(?:&apos;|'|&quot;|\")";
    private static final Pattern ROUTE_BY_NAME =
        Pattern.compile("router\\.routeMessage\\(\\s*" + QUOTE + "(.*?)" + QUOTE);
    private static final Pattern ROUTE_BY_ID =
        Pattern.compile("router\\.routeMessageByChannelId\\(\\s*" + QUOTE + "(.*?)" + QUOTE);

    // The Route with Sources library's functions are called without the
    // "router." prefix; the lookbehind keeps the two forms apart.
    private static final Pattern TRACED_ROUTE_BY_NAME =
        Pattern.compile("(?<!router\\.)\\brouteMessage\\s*\\(\\s*" + QUOTE + "(.*?)" + QUOTE);
    private static final Pattern TRACED_ROUTE_BY_ID =
        Pattern.compile("(?<!router\\.)\\brouteMessageByChannelId\\s*\\(\\s*" + QUOTE + "(.*?)" + QUOTE);

    public MessageFlowServlet(@Context HttpServletRequest request,
                               @Context ServletContext servletContext,
                               @Context SecurityContext sc) {
        super(request, sc);
        // servletContext is unused. The parameter stays because the REST
        // framework instantiates servlets by this 3-argument shape.
    }

    // ── REST operations ──────────────────────────────────────────────────

    @Override
    public Response getTopology() {
        try {
            // ChannelController.getChannels() returns every channel on the
            // engine with no awareness of what the current user may see.
            // MirthServlet.redactChannels() is that filter, and calling the
            // controller raw bypasses it.
            List<Channel> channels = redactChannels(ChannelController.getInstance().getChannels(null));
            Map<String, Object> result = buildTopology(channels);
            return Response.ok(MAPPER.writeValueAsString(result), MediaType.APPLICATION_JSON).build();
        } catch (Exception e) {
            return serverError("build topology", e);
        }
    }

    @Override
    public Response getMessageTrace(String channelId, Long messageId) {
        try {
            if (channelId == null || channelId.isEmpty() || messageId == null) {
                return badRequest("channelId and messageId are both required");
            }

            // The caller supplies channelId directly, so it has to be checked
            // before any message content is read: without this, a user who
            // cannot see a channel can still read its messages by naming it.
            // Answer 404 rather than 403 so the response does not disclose
            // that the channel exists.
            if (isChannelRedacted(channelId)) {
                return notFound("Message " + messageId + " was not found in channel " + channelId);
            }

            List<Channel> channels = redactChannels(ChannelController.getInstance().getChannels(null));
            Map<String, String> idToName = new LinkedHashMap<>();
            for (Channel c : channels) idToName.put(c.getId(), c.getName());

            Message root = MessageController.getInstance().getMessageContent(channelId, messageId, new ArrayList<>());
            if (root == null) {
                return notFound("Message " + messageId + " was not found in channel " + idToName.getOrDefault(channelId, channelId));
            }

            // Same channel-to-channel edges the topology graph uses, so the
            // forward scan only checks channels this one can actually reach.
            Map<String, List<String>> downstreamOf = buildDownstreamAdjacency(channels);

            TraceBudget budget = new TraceBudget();
            List<Map<String, Object>> ancestors = traceAncestors(root, idToName, budget);

            List<Map<String, Object>> descendants = new ArrayList<>();
            Set<String> visited = new HashSet<>();
            visited.add(channelId + ":" + messageId);
            traceDescendants(channelId, messageId, root.getReceivedDate(), downstreamOf, idToName, descendants, visited, 0, budget);

            Map<String, Object> result = new LinkedHashMap<>();
            result.put("channelId", channelId);
            result.put("channelName", idToName.get(channelId));
            result.put("messageId", messageId);
            result.put("ancestors", ancestors);
            result.put("descendants", descendants);
            result.put("truncated", budget.truncated);
            result.put("scanErrors", budget.errors);
            return Response.ok(MAPPER.writeValueAsString(result), MediaType.APPLICATION_JSON).build();
        } catch (Exception e) {
            return serverError("trace message " + messageId + " in channel " + channelId, e);
        }
    }

    /**
     * Logs the real failure server-side and returns only an opaque reference to
     * the caller. An exception message can carry SQL text, internal paths or
     * message content, none of which belongs in an HTTP response.
     */
    private Response serverError(String what, Exception e) {
        String reference = UUID.randomUUID().toString().substring(0, 8);
        LOGGER.error("Message Flow: failed to " + what + " [ref=" + reference + "]", e);
        Map<String, Object> err = new LinkedHashMap<>();
        err.put("error", "Message Flow could not complete the request. Check the server log for reference " + reference + ".");
        err.put("reference", reference);
        return json(Response.Status.INTERNAL_SERVER_ERROR.getStatusCode(), err);
    }

    private Response notFound(String message) {
        return json(Response.Status.NOT_FOUND.getStatusCode(), Collections.singletonMap("error", message));
    }

    private Response badRequest(String message) {
        return json(Response.Status.BAD_REQUEST.getStatusCode(), Collections.singletonMap("error", message));
    }

    private Response json(int status, Map<String, ?> body) {
        String entity;
        try {
            entity = MAPPER.writeValueAsString(body);
        } catch (Exception e) {
            // Only reachable if Jackson cannot serialize a map of strings.
            // Hand back a fixed literal rather than hand-building JSON around
            // text that would then need escaping of its own.
            LOGGER.error("Message Flow: could not serialize an error response", e);
            entity = "{\"error\":\"Message Flow could not complete the request.\"}";
        }
        return Response.status(status).entity(entity).type(MediaType.APPLICATION_JSON).build();
    }

    /**
     * Caps the total work one trace request may do. Every message-content read
     * costs a round trip to the message store, and the descendant walk fans out
     * per match, so without a ceiling a single HTTP request can turn into
     * thousands of reads. When the budget runs out the trace returns what it
     * found so far with truncated=true rather than running on.
     */
    static final class TraceBudget {
        private int lookups = 0;
        int errors = 0;
        /** Set only when a read was actually refused, so a trace that finishes
            using its last unit is not reported as cut short. */
        boolean truncated = false;

        boolean take() {
            if (lookups >= MAX_TRACE_LOOKUPS) {
                truncated = true;
                return false;
            }
            lookups++;
            return true;
        }

        /** No capacity left. Unlike take(), asking does not mark the trace
            as cut short: a walk that stops here may have nothing left to do. */
        boolean spent() {
            return lookups >= MAX_TRACE_LOOKUPS;
        }
    }

    // ── message trace: ancestors (free -- already on the message's own Source Map) ──

    // A routed message's Source Map carries both the immediate parent
    // (sourceChannelId/sourceMessageId) and the accumulated chain
    // (sourceChannelIds/sourceMessageIds). Prefer the chain, which is the
    // whole upstream lineage in one read, oldest first; fall back to the
    // singular pair for a message routed only once.
    private List<Map<String, Object>> traceAncestors(Message root, Map<String, String> idToName, TraceBudget budget) {
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

        // The Route with Sources library substitutes these when called with no
        // message in scope, e.g. from a deploy script. They name no real
        // channel or message, so reporting them as a deleted channel would be
        // wrong twice over.
        while (!chainChannelIds.isEmpty()
                && ("NONE".equals(chainChannelIds.get(0))
                    || (!chainMessageIds.isEmpty() && chainMessageIds.get(0) != null && chainMessageIds.get(0) == -1L))) {
            chainChannelIds = chainChannelIds.subList(1, chainChannelIds.size());
            if (!chainMessageIds.isEmpty()) chainMessageIds = chainMessageIds.subList(1, chainMessageIds.size());
        }

        int n = Math.min(chainChannelIds.size(), chainMessageIds.size());
        // Keep the most recent hops: the far end of a long chain is the loop's
        // history, the near end is what the reader is actually looking at.
        int from = Math.max(0, n - MAX_TRACE_HOPS);
        if (from > 0) budget.truncated = true;
        for (int i = from; i < n; i++) {
            String hopChannelId = chainChannelIds.get(i);
            Map<String, Object> hop;
            if (isChannelRedacted(hopChannelId)) {
                // The Source Map records the real routing chain regardless of
                // who reads it, so a hop can name a channel this user is not
                // allowed to see. Report that the hop happened, since the shape
                // of the chain is already implied by the message they can see,
                // but read nothing from it.
                hop = new LinkedHashMap<>();
                hop.put("channelId", hopChannelId);
                hop.put("channelName", null);
                hop.put("messageId", chainMessageIds.get(i));
                hop.put("restricted", true);
            } else {
                // A hop naming a channel that no longer exists is not
                // restricted, and summarizeMessage reports it as notFound.
                hop = summarizeMessage(hopChannelId, chainMessageIds.get(i), idToName, budget);
            }
            hop.put("hop", -(n - i));
            out.add(hop);
        }
        return out;
    }

    // ── message trace: descendants (bounded forward scan -- no server-side ──
    // ── index exists for "find the message that came from this one") ────────

    private static final int MAX_TRACE_DEPTH = 5;
    // Each candidate costs one extra getMessageContent() round trip (see
    // below), so this bounds real cost per channel per hop rather than just
    // result-list size.
    private static final int FORWARD_SCAN_LIMIT = 50;
    // Ceiling on message-content reads for one whole trace request. Depth and
    // per-channel limits alone do not bound the total: the walk recurses per
    // match, so a wide graph multiplies them together.
    private static final int MAX_TRACE_LOOKUPS = 500;
    /**
     * Cap on hops reported in either direction. Channel Writer appends to
     * sourceChannelIds on every hop, so a channel that routes back into its own
     * upstream produces a chain that grows without bound: A to B to A to B is a
     * legitimate configuration, and each lap adds an entry. Nothing else here
     * bounds the ancestor list, since it is read from the map rather than
     * walked, and a client rendering one node per hop cannot absorb hundreds.
     */
    private static final int MAX_TRACE_HOPS = 50;

    private void traceDescendants(String channelId, Long messageId, Calendar notBefore,
            Map<String, List<String>> downstreamOf, Map<String, String> idToName,
            List<Map<String, Object>> out, Set<String> visited, int depth, TraceBudget budget) {
        if (depth >= MAX_TRACE_DEPTH || budget.spent()) return;
        List<String> candidates = downstreamOf.get(channelId);
        if (candidates == null || candidates.isEmpty()) return;

        for (String candidateChannelId : candidates) {
            if (budget.spent() || out.size() >= MAX_TRACE_HOPS) return;
            List<Message> candidateMessages;
            try {
                MessageFilter filter = new MessageFilter();
                if (notBefore != null) filter.setStartDate(notBefore);
                candidateMessages = MessageController.getInstance().getMessages(filter, candidateChannelId, Boolean.FALSE, 0, FORWARD_SCAN_LIMIT);
            } catch (Exception e) {
                // Counted and returned with the response rather than logged:
                // this runs per message, and a per-message log line carries no
                // message context and pages out of the console anyway.
                budget.errors++;
                continue;
            }
            if (candidateMessages == null) continue;

            for (Message summary : candidateMessages) {
                if (!budget.take()) return;

                // getMessages() (search) returns lightweight summaries for grid
                // display, not full connector-message content, so every
                // candidate's Source Map reads as null and nothing ever
                // matches. Re-fetch full content explicitly via the same call
                // ancestor-tracing already uses.
                Long candidateMessageId = summary.getMessageId();
                Message candidate;
                try {
                    candidate = MessageController.getInstance().getMessageContent(candidateChannelId, candidateMessageId, new ArrayList<>());
                } catch (Exception e) {
                    budget.errors++;
                    continue;
                }
                if (candidate == null) continue;

                ConnectorMessage src = candidate.getConnectorMessages() != null ? candidate.getConnectorMessages().get(0) : null;
                if (src == null) continue;
                Map<String, Object> sm = src.getSourceMap();
                if (sm == null || !matchesAncestor(sm, channelId, messageId)) continue;

                String key = candidateChannelId + ":" + candidateMessageId;
                if (!visited.add(key)) continue; // already recorded via a different candidate path

                Map<String, Object> hit = summarizeFetched(candidateChannelId, candidateMessageId, idToName, candidate);
                hit.put("hop", depth + 1);
                // The node this specific message actually came from -- channelId/
                // messageId are this method's own parameters, i.e. the parent
                // being expanded in this recursive call. Without this, every
                // branch at the same hop is indistinguishable from a single
                // chain in list order, which is what the Message Flow client
                // used to (wrongly) assume.
                hit.put("parentChannelId", channelId);
                hit.put("parentMessageId", messageId);
                out.add(hit);

                traceDescendants(candidateChannelId, candidateMessageId, candidate.getReceivedDate(),
                    downstreamOf, idToName, out, visited, depth + 1, budget);
            }
        }
    }

    private boolean matchesAncestor(Map<String, Object> sourceMap, String channelId, Long messageId) {
        Object singleChan = sourceMap.get("sourceChannelId");
        Long singleMsg = asLong(sourceMap.get("sourceMessageId"));
        if (channelId.equals(String.valueOf(singleChan)) && messageId.equals(singleMsg)) return true;

        List<String> chainChannelIds = asStringList(sourceMap.get("sourceChannelIds"));
        List<Long> chainMessageIds = asLongList(sourceMap.get("sourceMessageIds"));
        // The Route with Sources library substitutes these when called with no
        // message in scope, e.g. from a deploy script. They name no real
        // channel or message, so reporting them as a deleted channel would be
        // wrong twice over.
        while (!chainChannelIds.isEmpty()
                && ("NONE".equals(chainChannelIds.get(0))
                    || (!chainMessageIds.isEmpty() && chainMessageIds.get(0) != null && chainMessageIds.get(0) == -1L))) {
            chainChannelIds = chainChannelIds.subList(1, chainChannelIds.size());
            if (!chainMessageIds.isEmpty()) chainMessageIds = chainMessageIds.subList(1, chainMessageIds.size());
        }

        int n = Math.min(chainChannelIds.size(), chainMessageIds.size());
        for (int i = 0; i < n; i++) {
            if (channelId.equals(chainChannelIds.get(i)) && messageId.equals(chainMessageIds.get(i))) return true;
        }
        return false;
    }

    // ── parsed routing, memoized per channel revision ────────────────────

    /**
     * One channel's parsed routing. Serializing a channel and running the
     * routing regexes over the result is the expensive part of every request
     * here, and both the topology graph and the trace's adjacency need it. The
     * engine bumps a channel's revision on every save, so that is a sound
     * invalidation signal: a cached entry is reused only for the exact revision
     * it was parsed from.
     */
    private static final class ChannelRouting {
        final int revision;
        final String sourceTransport;
        final List<Destination> destinations;
        final List<ScriptRoute> scriptRoutes;

        ChannelRouting(int revision, String xml) {
            this.revision = revision;
            this.sourceTransport = parseSourceTransport(xml);
            this.destinations = parseChannelDestinations(xml);
            this.scriptRoutes = parseScriptRouting(xml);
        }
    }

    /**
     * Whether a channel's storage settings keep the source map, which is what
     * every trace is read from. Verified against DonkeyEngineController: RAW
     * and METADATA both call setStoreMaps(false), and DISABLED stores nothing,
     * so only DEVELOPMENT and PRODUCTION retain it. removeContentOnCompletion
     * then deletes it again once the message finishes, because the source map
     * is message content rather than metadata.
     *
     * Returned as the setting responsible and what it means, in the engine's
     * own words, because a reader fixes this by changing a named setting on a
     * named tab rather than by understanding a property.
     */
    private static String[] traceGap(Channel c) {
        ChannelProperties props = c.getProperties();
        if (props == null) return null;
        MessageStorageMode mode = props.getMessageStorageMode();
        if (mode == MessageStorageMode.DISABLED) {
            return new String[] { "Message storage is disabled",
                "No messages are stored for this channel, so there is nothing for a trace to read." };
        }
        if (mode == MessageStorageMode.RAW || mode == MessageStorageMode.METADATA) {
            return new String[] { "Storage mode is " + mode,
                "The source map is message content, and this mode does not store maps. Production or Development keeps it." };
        }
        if (props.isRemoveContentOnCompletion()) {
            return new String[] { "Remove content on completion is on",
                "The source map is message content, so it is deleted as soon as a message finishes processing." };
        }
        return null;
    }

    /** Empty routing, for a channel whose XML could not be produced. */
    private static final ChannelRouting NO_ROUTING = new ChannelRouting(Integer.MIN_VALUE, "");

    private static final Map<String, ChannelRouting> ROUTING_CACHE = new ConcurrentHashMap<>();

    // Entries are small (parsed destinations and route calls, not the XML), so
    // this only guards against unbounded growth as channels are created and
    // deleted over a long uptime. Clearing wholesale is crude on purpose: the
    // next request repopulates what it needs.
    private static final int MAX_CACHED_CHANNELS = 2000;

    private static ChannelRouting routingOf(Channel c) {
        Integer revision = c.getRevision();
        if (revision != null) {
            ChannelRouting cached = ROUTING_CACHE.get(c.getId());
            if (cached != null && cached.revision == revision.intValue()) return cached;
        }

        String xml;
        try {
            xml = ObjectXMLSerializer.getInstance().serialize(c);
        } catch (Exception e) {
            LOGGER.warn("Message Flow: could not serialize channel " + c.getName() + " (" + c.getId() + "); its routing is omitted", e);
            return NO_ROUTING;
        }

        ChannelRouting parsed = new ChannelRouting(revision != null ? revision.intValue() : Integer.MIN_VALUE, xml);
        // Only cacheable when the channel carries a revision to invalidate on.
        if (revision != null) {
            if (ROUTING_CACHE.size() >= MAX_CACHED_CHANNELS) ROUTING_CACHE.clear();
            ROUTING_CACHE.put(c.getId(), parsed);
        }
        return parsed;
    }

    // Channel-to-channel adjacency as fromId -> [toId, ...], from the same
    // Channel Writer destinations and script routing calls the topology graph
    // uses. Kept separate from buildTopology() so the trace path's shape is not
    // coupled to the topology response's shape; both read the same memoized
    // parse, so the duplication costs nothing.
    private Map<String, List<String>> buildDownstreamAdjacency(List<Channel> channels) {
        Map<String, List<String>> adjacency = new LinkedHashMap<>();
        Map<String, String> nameToId = new LinkedHashMap<>();
        Set<String> visible = new HashSet<>();
        for (Channel c : channels) {
            nameToId.put(c.getName(), c.getId());
            visible.add(c.getId());
        }

        for (Channel c : channels) {
            ChannelRouting routing = routingOf(c);
            for (Destination d : routing.destinations) {
                addReachable(adjacency, visible, c.getId(), d.targetChannelId);
            }
            for (ScriptRoute r : routing.scriptRoutes) {
                addReachable(adjacency, visible, c.getId(),
                    "routeMessageByChannelId".equals(r.method) ? r.value : nameToId.get(r.value));
            }
        }
        return adjacency;
    }

    /**
     * Redacting the source channels is not enough: a visible channel can name a
     * target the caller cannot see, and the descendant scan reads messages out
     * of every channel in this map. Only targets the caller may see are
     * reachable, so the scan can never read a restricted channel's messages.
     */
    private void addReachable(Map<String, List<String>> adjacency, Set<String> visible, String fromId, String toId) {
        if (toId == null || !visible.contains(toId)) return;
        adjacency.computeIfAbsent(fromId, k -> new ArrayList<>()).add(toId);
    }

    // Just enough about one message to display it in a trace: status and
    // received time, from its source connector message.
    private Map<String, Object> summarizeMessage(String channelId, Long messageId, Map<String, String> idToName, TraceBudget budget) {
        if (!budget.take()) {
            Map<String, Object> m = identity(channelId, messageId, idToName);
            m.put("status", null);
            m.put("truncated", true);
            return m;
        }
        try {
            return summarizeFetched(channelId, messageId, idToName,
                MessageController.getInstance().getMessageContent(channelId, messageId, new ArrayList<>()));
        } catch (Exception e) {
            budget.errors++;
            Map<String, Object> m = identity(channelId, messageId, idToName);
            m.put("status", null);
            m.put("lookupError", true);
            return m;
        }
    }

    /**
     * Summarizes a message already read from the store. Callers holding the
     * Message must use this rather than summarizeMessage(): the descendant scan
     * fetches every candidate to check its Source Map, and re-fetching the ones
     * that matched doubled both the round trips and the budget spend.
     */
    private Map<String, Object> summarizeFetched(String channelId, Long messageId, Map<String, String> idToName, Message msg) {
        Map<String, Object> m = identity(channelId, messageId, idToName);
        if (msg == null) {
            m.put("status", null);
            m.put("receivedDate", null);
            m.put("notFound", true);
            return m;
        }
        ConnectorMessage src = msg.getConnectorMessages() != null ? msg.getConnectorMessages().get(0) : null;
        m.put("status", src != null && src.getStatus() != null ? src.getStatus().toString() : null);
        m.put("receivedDate", msg.getReceivedDate() != null ? msg.getReceivedDate().getTimeInMillis() : null);
        return m;
    }

    private Map<String, Object> identity(String channelId, Long messageId, Map<String, String> idToName) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("channelId", channelId);
        m.put("channelName", idToName.get(channelId));
        m.put("messageId", messageId);
        return m;
    }

    @SuppressWarnings("unchecked")
    static List<String> asStringList(Object v) {
        if (v == null) return Collections.emptyList();
        if (v instanceof List) {
            List<String> out = new ArrayList<>();
            for (Object o : (List<Object>) v) out.add(String.valueOf(o));
            return out;
        }
        return Collections.singletonList(String.valueOf(v));
    }

    @SuppressWarnings("unchecked")
    static List<Long> asLongList(Object v) {
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

    static Long asLong(Object v) {
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

        for (Channel c : channels) {
            ChannelRouting routing = routingOf(c);

            Map<String, Object> node = new LinkedHashMap<>();
            node.put("id", c.getId());
            node.put("name", c.getName());
            node.put("sourceTransport", routing.sourceTransport);
            String[] gap = traceGap(c);
            node.put("traceGapCause", gap == null ? null : gap[0]);
            node.put("traceGap", gap == null ? null : gap[1]);
            nodes.add(node);

            for (Destination d : routing.destinations) {
                if (d.unconfigured) {
                    /* A Channel Writer set to None reports SENT and delivers
                       nowhere, so nothing else on the engine will ever surface
                       it. Hiding it was the wrong instinct for a map whose job
                       is showing where messages go: it is a route to nowhere,
                       and that is worth drawing. */
                    unconfiguredCount++;
                    Map<String, Object> edge = new LinkedHashMap<>();
                    edge.put("fromId", c.getId());
                    edge.put("fromName", c.getName());
                    edge.put("toId", null);
                    edge.put("toName", null);
                    edge.put("toNone", true);
                    edge.put("destName", d.name);
                    edge.put("via", "connector");
                    edge.put("destinationId", d.metaDataId);
                    edge.put("enabled", d.enabled);
                    edges.add(edge);
                    continue;
                }
                if (d.targetChannelId != null) {
                    Map<String, Object> edge = new LinkedHashMap<>();
                    edge.put("fromId", c.getId());
                    edge.put("fromName", c.getName());
                    edge.put("toId", d.targetChannelId);
                    edge.put("toName", idToName.get(d.targetChannelId));
                    // A target absent from idToName is either restricted or
                    // gone. Saying which is the difference between "somebody
                    // else's channel" and "this route is broken", and only the
                    // second one is a problem the reader should act on.
                    edge.put("toRestricted", !idToName.containsKey(d.targetChannelId) && isChannelRedacted(d.targetChannelId));
                    edge.put("destName", d.name);
                    edge.put("via", "connector");
                    edge.put("destinationId", d.metaDataId);
                    edge.put("enabled", d.enabled);
                    edges.add(edge);
                } else if (d.transportName != null) {
                    Map<String, Object> ext = new LinkedHashMap<>();
                    ext.put("channelId", c.getId());
                    ext.put("channelName", c.getName());
                    ext.put("destName", d.name);
                    ext.put("destinationId", d.metaDataId);
                    ext.put("transportName", d.transportName);
                    ext.put("enabled", d.enabled);
                    ext.put("dynamicRouting", d.dynamicRouting);
                    ext.put("dynamicTarget", d.dynamicRouting ? d.rawTarget : null);
                    externalDestinations.add(ext);
                }
            }

            for (ScriptRoute r : routing.scriptRoutes) {
                String toId = "routeMessageByChannelId".equals(r.method) ? r.value : nameToId.get(r.value);
                // A script route names its target as literal text in the
                // channel's own script, so echoing it back discloses nothing
                // the reader cannot already read in their own channel.
                Map<String, Object> edge = new LinkedHashMap<>();
                edge.put("fromId", c.getId());
                edge.put("fromName", c.getName());
                edge.put("toId", toId);
                edge.put("toName", toId != null ? idToName.get(toId) : r.value);
                edge.put("toRestricted", toId != null && !idToName.containsKey(toId) && isChannelRedacted(toId));
                edge.put("destName", (r.traced ? "" : "router.") + r.method + "('" + r.value + "')");
                edge.put("via", "script");
                edge.put("enabled", null); // unknown, may be conditional inside the script
                edge.put("viaScript", true);
                edge.put("traceable", r.traced);
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

    /** A channel's single source connector transport, which is what kind of interface it is. */
    static String parseSourceTransport(String channelXml) {
        if (channelXml == null) return null;
        Matcher srcBlock = SOURCE_CONNECTOR_BLOCK.matcher(channelXml);
        if (!srcBlock.find()) return null;
        Matcher transport = TRANSPORT_NAME.matcher(srcBlock.group(1));
        return transport.find() ? transport.group(1) : null;
    }

    static final class Destination {
        /** The connector's metaDataId, which is how the editor numbers and the
            message browser labels it. Null when the XML does not carry one. */
        Integer metaDataId;
        String name;
        String transportName;
        boolean enabled;
        String targetChannelId; // non-null only for a configured, non-dynamic Channel Writer
        /** The target exactly as configured. For a dynamic destination this is
            the template, e.g. ${targetChannel}, which names what decides the
            target and is more use than saying merely that something does. */
        String rawTarget;
        boolean dynamicRouting;
        boolean unconfigured;
    }

    static List<Destination> parseChannelDestinations(String channelXml) {
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

            Matcher metaMatcher = METADATA_ID_TAG.matcher(block);
            Integer metaDataId = metaMatcher.find() ? Integer.valueOf(metaMatcher.group(1)) : null;

            Matcher transportMatcher = TRANSPORT_NAME.matcher(block);
            String transportName = transportMatcher.find() ? transportMatcher.group(1) : null;

            // <enabled> appears once per transformer step and once for the
            // connector itself. The connector's own value is the last match.
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
            d.metaDataId = metaDataId;
            d.name = name != null ? name : "(unnamed destination)";
            d.transportName = transportName;
            d.enabled = enabledLast == null || "true".equals(enabledLast);
            d.targetChannelId = (isChannelWriter && !isUnconfigured && !isDynamic) ? rawChannelId : null;
            d.rawTarget = rawChannelId;
            d.dynamicRouting = isDynamic;
            d.unconfigured = isUnconfigured;
            destinations.add(d);
        }
        return destinations;
    }

    static final class ScriptRoute {
        String method; // "routeMessage" | "routeMessageByChannelId"
        String value;
        /**
         * Whether this call records lineage. A bare routeMessage() comes from
         * the Route with Sources library and stamps the source map; a
         * router.routeMessage() does not, so a message taking that hop arrives
         * downstream with nothing saying where it came from.
         */
        boolean traced;
    }

    // Whether a matched position sits inside a JavaScript comment. Tracks
    // string-literal state, including entity-escaped quotes, so a // or /*
    // inside a string (a logged URL, a note mentioning a ticket) is not read
    // as a comment opener. Not a full tokenizer: template literals and regex
    // literals are not handled.
    static boolean isPositionCommentedOut(String text, int pos) {
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

    static List<ScriptRoute> parseScriptRouting(String channelXml) {
        List<ScriptRoute> calls = new ArrayList<>();
        if (channelXml == null) return calls;
        collectRoutes(channelXml, ROUTE_BY_NAME, "routeMessage", false, calls);
        collectRoutes(channelXml, ROUTE_BY_ID, "routeMessageByChannelId", false, calls);
        collectRoutes(channelXml, TRACED_ROUTE_BY_NAME, "routeMessage", true, calls);
        collectRoutes(channelXml, TRACED_ROUTE_BY_ID, "routeMessageByChannelId", true, calls);
        return calls;
    }

    private static void collectRoutes(String channelXml, Pattern pattern,
            String method, boolean traced, List<ScriptRoute> into) {
        Matcher m = pattern.matcher(channelXml);
        while (m.find()) {
            if (isPositionCommentedOut(channelXml, m.start())) continue;
            ScriptRoute r = new ScriptRoute();
            r.method = method;
            r.value = m.group(1);
            r.traced = traced;
            into.add(r);
        }
    }
}
