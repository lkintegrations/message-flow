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
 * REST surface for Message Flow, mounted under /api/extensions/messageFlow.
 *
 * Both operations are read-only and both are called by fetch() from inside the
 * web administrator, which is what satisfies the engine's X-Requested-With
 * requirement on /api.
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
    @Operation(summary = "Traces one message's actual runtime lineage: ancestors from its own Source Map, descendants via a bounded forward scan of the channels it can route to.")
    @MirthOperation(name = "getMessageTrace", display = "Get Message Flow message trace", auditable = true)
    Response getMessageTrace(@QueryParam("channelId") String channelId, @QueryParam("messageId") Long messageId);
}
