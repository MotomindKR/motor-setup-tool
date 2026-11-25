export async function clickSidebarControl(page, control) {
  if (!(await control.isVisible()))
    await page.locator('[data-slot="sidebar-trigger"]').click();
  await control.click();
}

export async function selectWorkspace(page, name, label = "Workspace") {
  await clickSidebarControl(page, page.getByRole("combobox", { name: label, exact: true }));
  await page.getByRole("listbox").getByRole("option", { name, exact: true }).click();
}
