package org.openintegrationengine.plugins.messageflow;

import java.util.Map;
import java.util.Properties;

import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;

import com.mirth.connect.model.ExtensionPermission;
import com.mirth.connect.plugins.ServicePlugin;

/**
 * Server-side lifecycle for Message Flow.
 *
 * There is nothing to deploy here. The user interface is
 * webadmin/web/plugin.js, discovered and served by the Web Support plugin's
 * getWebPluginPaths()/getWebPluginResource(), and it runs inside that already
 * authenticated shell using the shell's own platform.api. This class exists to
 * register the plugin point name and the permission the REST operations
 * require.
 */
public class MessageFlowServicePlugin implements ServicePlugin {

    private static final Logger LOGGER = LogManager.getLogger(MessageFlowServicePlugin.class);

    /** Must match plugin.xml's apiProvider servlet @Path("/extensions/messageFlow"). */
    public static final String PLUGIN_POINT = "messageFlow";

    @Override
    public void init(Properties properties) {
        // No configurable properties yet.
    }

    @Override
    public void update(Properties properties) {
        // No configurable properties yet.
    }

    @Override
    public Properties getDefaultProperties() {
        return new Properties();
    }

    @Override
    public ExtensionPermission[] getExtensionPermissions() {
        return new ExtensionPermission[] {
            new ExtensionPermission(
                PLUGIN_POINT,
                "Message Flow",
                "View the Message Flow channel routing map and trace a message's routing lineage (read-only; no channel or message data is modified).",
                new String[] { "getTopology", "getMessageTrace" },
                new String[0]
            )
        };
    }

    @Override
    public Map<String, Object> getObjectsForSwaggerExamples() {
        return null;
    }

    @Override
    public String getPluginPointName() {
        return PLUGIN_POINT;
    }

    @Override
    public void start() {
        LOGGER.info("Message Flow: ready at /api/extensions/" + PLUGIN_POINT + "/topology (nav tab served via webadmin/web/plugin.js)");
    }

    @Override
    public void stop() {
        // Nothing to release.
    }
}
