# Character turnaround boards

Read only for `character` assets.

## Purpose

Lock one character's face, hair, age presentation, body proportions, primary costume, accessories, and footwear for reuse across video segments. One asset ID represents one stable look.

## Default composition

- horizontal 16:9 production board when the tool supports that request;
- clean white or neutral seamless background with subtle contact shadows;
- left column: a large frontal facial close-up above a clear side facial close-up;
- next to the face column: the current character's name or role as a visible title and a concise profile area;
- remaining width: three clearly labeled complete full-body views, front, strict 90-degree side, and back, with consistent scale and ground line;
- the same person, hairstyle, face, body, costume, accessories, colors, and materials in every panel;
- neutral standing posture and neutral expression unless the handoff locks another state;
- realistic skin pores, hair strands, fabric weave, leather/metal wear, and physically credible soft studio lighting.

Write the actual name/role title, view labels, and profile facts into the generation prompt along with their placement. Include height/weight when known; if absent, omit the numbers or use the supplied non-numeric body description, without blocking generation or guessing measurements. Use `exactText` only for user-requested verbatim copy, not as permission for ordinary board text. Empty `exactText` does not remove the name or profile. A layout reference supplies this arrangement, not the example's identity, clothing, name, or measurements.

## Prompt content

Restate the handoff's exact:

- name or role label;
- presented gender and age only when established;
- height/body description;
- hair and facial features;
- skin tone and visible texture;
- every garment, color, material, fit, and wear state;
- accessories and their exact side/position;
- footwear;
- identity invariants from dependency images.

## Presentation

Present the same character in each view with a complete visible body in the full-body panels, stable proportions, consistent costume and accessory placement, and clear frontal and side face close-ups. Use the neutral studio setting and realistic materials described above. Preserve the supplied identity and state through positive visual description.

Multiple panels of the same character are expected; multiple different people are not.
