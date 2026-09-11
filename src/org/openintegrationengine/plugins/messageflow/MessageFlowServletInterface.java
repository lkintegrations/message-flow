package org.openintegrationengine.plugins.messageflow;

import javax.ws.rs.Consumes;
import javax.ws.rs.GET;
import javax.ws.rs.Path;
import javax.ws.rs.Produces;
import javax.ws.rs.QueryParam;
import javax.ws.rs.core.MediaType;
import javax.ws.rs.core.Response;

import com.mirth.connect.client.core.api.BaseServletInterface;
import com.mirth.connect.client.core.api.MirthOperation;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;

/**
 * REST surface for Message Flow. Mounted (like Web Support) under
 * /api/extensions/{path}, per plugin.xml's pluginMetaData path="messageFlow".
 *
 * Both operations are read-only. The viewer itself is a Web Support nav
 * tab/channel-editor tab (webadmin/web/plugin.js), not served from here --
 * this interface only ever answers JS fetch() calls made from inside the
 * already-authenticated shell (which is what lets it satisfy the engine's
 * /api X-Requested-With requirement in the first place).
 */
@Path("/extensions/messageFlow")
@Tag(name = "Extension Services")
@Consumes(MediaType.APPLICATION_JSON)
@Produces(MediaType.APPLICATION_JSON)
public interface MessageFlowServletInterface extends BaseServletInterface {

    @GET
    @Path("/topology")
    @Produces(MediaType.APPLICATION_JSON)
    @Operation(summary = "Returns the channel routing graph: { nodes, edges, externalDestinations, unconfiguredCount }.")
    @MirthOperation(name = "getTopology", display = "Get Message Flow topology", auditable = false)
    Response getTopology();

    @GET
    @Path("/trace")
    @Produces(MediaType.APPLICATION_JSON)
    @Operation(summary = "Traces one specific message's actual runtime lineage: ancestors read straight from its own Source Map (sourceChannelId(s)/sourceMessageId(s), which the engine writes on every Channel Writer/router.routeMessage hop), and descendants via a bounded forward scan of the channels this one can route to.")
    @MirthOperation(name = "getMessageTrace", display = "Get Message Flow message trace", auditable = false)
    Response getMessageTrace(@QueryParam("channelId") String channelId, @QueryParam("messageId") Long messageId);
}
