package org.openintegrationengine.plugins.messageflow;

import java.util.Map;
import java.util.Properties;

import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;

import com.mirth.connect.model.ExtensionPermission;
import com.mirth.connect.plugins.ServicePlugin;

/**
 * Server-side lifecycle class for the Message Flow contribution to
 * Web Support.
 *
 * This is deliberately much simpler than the earlier standalone version's
 * MessageFlowServicePlugin: that one had to build and deploy its own static
 * WAR to work around the /api layer's CSRF header requirement, because it
 * had nowhere else to put its HTML page. Folded into Web Support, the page
 * doesn't exist server-side at all anymore -- it's webadmin/web/plugin.js,
 * discovered and loaded by Web Support's own getWebPluginPaths()/
 * getWebPluginResource() mechanism (the same one that lets built-in
 * connector/datatype panels contribute UI), and it runs inside the
 * already-authenticated shell using the shell's own platform.api (which
 * already sets X-Requested-With). So there's nothing to deploy here: this
 * class exists only to register the plugin point name and the permission
 * the /topology REST operation requires.
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
                "View the Message Flow channel routing map (read-only; no channel or message data is modified).",
                new String[] { "getTopology" },
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
