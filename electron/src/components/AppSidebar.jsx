import React from "react";
import { Settings2 } from "lucide-react";
import { MotomindLogo } from "@motomindkr/ui/components/motomind-logo";
import { MotomindSymbol } from "@motomindkr/ui/components/motomind-symbol";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
  useSidebar,
} from "@motomindkr/ui/components/sidebar";

export function AppSidebar({
  pages,
  activeTab,
  onNavigate,
  onSettings,
  updateAvailable,
}) {
  const { state, isMobile, setOpenMobile } = useSidebar();
  const compact = state === "collapsed" && !isMobile;
  const navigate = (tab) => {
    if (isMobile) setOpenMobile(false);
    onNavigate(tab);
  };
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="app-sidebar-header">
        {compact ? (
          <MotomindSymbol />
        ) : (
          <>
            <MotomindLogo />
            <span className="sidebar-product-name">Motor Setup Tool</span>
          </>
        )}
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="app-sidebar-group">
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            <nav aria-label="Tool sections">
              <SidebarMenu className="app-sidebar-menu">
                {Object.entries(pages).map(([key, page]) => {
                  const Icon = page.icon;
                  return (
                    <SidebarMenuItem key={key}>
                      <SidebarMenuButton
                        size="lg"
                        isActive={activeTab === key}
                        aria-current={activeTab === key ? "page" : undefined}
                        aria-label={page.label}
                        tooltip={page.label}
                        onClick={() => navigate(key)}
                      >
                        <Icon />
                        <span>{page.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </nav>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarSeparator className="app-sidebar-separator" />
      <SidebarFooter className="app-sidebar-footer">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              aria-label="Settings"
              aria-description={updateAvailable ? "Update available" : undefined}
              tooltip={
                updateAvailable ? "Settings · Update available" : "Settings"
              }
              onClick={() => {
                if (isMobile) setOpenMobile(false);
                onSettings();
              }}
            >
              <span className="settings-menu-icon" aria-hidden="true">
                <Settings2 />
                {updateAvailable && <span className="settings-update-dot" />}
              </span>
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
