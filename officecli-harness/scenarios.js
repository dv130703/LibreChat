/**
 * The 5 scenarios from OFFICECLI_HARNESS.md, 4 runs each = 20 trials.
 * Scenario 1's prompt is a reconstructed equivalent of the original
 * broken-memo request, not the verbatim original (that text isn't
 * available — see OFFICECLI_HARNESS.md's stance on not fabricating
 * baselines). Scenario 2 needs a fixture document created before the
 * trial; setupFixture() builds it once via direct MCP calls (unscored).
 */

const FIXTURE_BUDGET_TEXT =
  'The Q3 budget remained flat at $240,000 across all departments, with no variance from the approved plan.';
const FIXTURE_TIMELINE_TEXT =
  'Phase 2 construction is on track for completion by November 15, with no changes to the critical path.';

async function setupFixture(client) {
  await client.callTool({ name: 'create_document', arguments: { file_path: 'report.docx' } });
  await client.callTool({
    name: 'add_element',
    arguments: {
      file_path: 'report.docx',
      parent_path: '/body',
      type: 'paragraph',
      properties: { text: 'Budget', style: 'Heading1' },
    },
  });
  await client.callTool({
    name: 'add_element',
    arguments: {
      file_path: 'report.docx',
      parent_path: '/body',
      type: 'paragraph',
      properties: { text: FIXTURE_BUDGET_TEXT },
    },
  });
  await client.callTool({
    name: 'add_element',
    arguments: {
      file_path: 'report.docx',
      parent_path: '/body',
      type: 'paragraph',
      properties: { text: 'Timeline', style: 'Heading1' },
    },
  });
  await client.callTool({
    name: 'add_element',
    arguments: {
      file_path: 'report.docx',
      parent_path: '/body',
      type: 'paragraph',
      properties: { text: FIXTURE_TIMELINE_TEXT },
    },
  });
}

const scenarios = [
  {
    id: 'status-memo',
    label: 'Status memo, verbatim (reconstructed)',
    needsFixture: false,
    prompt:
      'Write a one-page project status memo in Word format, saved as status-memo.docx. ' +
      'Include a title, a "Summary" section, a "Milestones" section listing 3 completed ' +
      'milestones, and a "Next Steps" section listing 3 upcoming items. Use proper heading ' +
      'styles for the section titles.',
    expectFilename: 'status-memo.docx',
    checks: ['markdownLeak', 'headingStyle', 'placeholderResidue'],
  },
  {
    id: 'edit-existing',
    label: 'Edit to a user-supplied .docx',
    needsFixture: true,
    prompt:
      'I\'ve attached report.docx. Update the Budget section to say the budget increased by ' +
      '10% for Q4 due to new hiring. Leave everything else in the document unchanged.',
    expectFilename: 'report.docx',
    checks: ['markdownLeak', 'placeholderResidue', 'timelineUnchanged'],
  },
  {
    id: 'table-insertion',
    label: 'Table insertion',
    needsFixture: false,
    prompt:
      'Create a Word document called schedule.docx with a table listing 4 project phases ' +
      '(Planning, Design, Build, Launch) and their target completion month. Include a header row.',
    expectFilename: 'schedule.docx',
    checks: ['markdownLeak', 'placeholderResidue', 'tableShape'],
  },
  {
    id: 'heading-hierarchy',
    label: 'Heading hierarchy',
    needsFixture: false,
    prompt:
      'Create a Word document called quarterly.docx for a quarterly report. It needs a ' +
      'top-level title "Quarterly Report", two major sections "Financial Overview" and ' +
      '"Operations", each containing two subsections. Use proper heading levels: Heading 1 ' +
      'for the title, Heading 2 for the major sections, Heading 3 for the subsections.',
    expectFilename: 'quarterly.docx',
    checks: ['markdownLeak', 'placeholderResidue', 'headingHierarchy'],
  },
  {
    id: 'underspecified',
    label: 'Underspecified request',
    needsFixture: false,
    prompt: 'Write something up about the Q3 numbers.',
    expectFilename: null,
    checks: ['clarificationOrDelivery'],
  },
];

module.exports = { scenarios, setupFixture, FIXTURE_BUDGET_TEXT, FIXTURE_TIMELINE_TEXT };
