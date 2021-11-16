import { Proposal, ProposalType } from '@prisma/client';
import {
  CommandInteraction,
  ContextMenuInteraction,
  Message,
  MessageEmbed,
  TextChannel
} from 'discord.js';
import prisma from '../../prisma';
import {
  correctionChannel,
  neededApprovals,
  suggestsChannel
} from '../constants';
import Command from '../lib/command';
import { renderGodfatherLine } from '../lib/godfathers';
import {
  interactionError,
  interactionInfo,
  interactionValidate
} from '../utils';

export default class DisapproveCommand extends Command {
  constructor() {
    super({
      name: 'Désapprouver',
      type: 'MESSAGE',
      parrainOnly: true
    });
  }

  async run(interaction: CommandInteraction): Promise<void> {
    const channel = (interaction.channel as TextChannel)!;
    const isSuggestion = channel.id === suggestsChannel;
    const message = await channel.messages.fetch(
      (interaction as ContextMenuInteraction).targetId
    );
    if (![suggestsChannel, correctionChannel].includes(channel.id)) {
      return interaction.reply(
        interactionError(
          `Vous ne pouvez pas désapprouver une blague ou une correction en dehors des salons <#${suggestsChannel}> et <#${correctionChannel}>.`
        )
      );
    }
    if (message.author.id !== interaction.client.user!.id) {
      return interaction.reply(
        interactionError(
          `Vous ne pouvez pas désapprouver une ${
            isSuggestion ? 'blague' : 'correction'
          } qui n'est pas gérée par ${interaction.client.user}.`
        )
      );
    }

    const proposal = await prisma.proposal.findUnique({
      where: {
        message_id: message.id
      },
      include: {
        corrections: isSuggestion && {
          take: 1,
          orderBy: {
            created_at: 'desc'
          },
          where: {
            merged: false
          }
        },
        suggestion: {
          include: {
            corrections: {
              take: 1,
              orderBy: {
                created_at: 'desc'
              },
              where: {
                merged: false
              }
            }
          }
        },
        disapprovals: true,
        approvals: true
      }
    });

    if (!proposal) {
      return interaction.reply(interactionError(`Le message est invalide.`));
    }

    const embed = message.embeds[0];
    if (!embed) {
      await prisma.proposal.delete({
        where: {
          id: proposal.id
        }
      });
      return interaction.reply(interactionError(`Le message est invalide.`));
    }

    // if (proposal.user_id === interaction.user.id) {
    //   return interaction.reply(
    //     interactionError(
    //       `Vous ne pouvez pas désapprouver votre propre ${
    //         isSuggestion ? 'blague' : 'correction'
    //       }.`
    //     )
    //   );
    // }

    if (proposal.merged) {
      return interaction.reply(
        interactionError(
          `Cette ${isSuggestion ? 'blague' : 'correction'} a déjà été ajoutée.`
        )
      );
    }

    if (proposal.refused) {
      return interaction.reply(
        interactionError(
          `Cette ${isSuggestion ? 'blague' : 'correction'} a déjà été refusée.`
        )
      );
    }

    const correction =
      proposal.type === ProposalType.SUGGESTION && proposal.corrections[0];
    if (correction && !correction.merged) {
      return interaction.reply(
        interactionInfo(
          `Il semblerait qu'une [correction ai été proposée](https://discord.com/channels/${
            interaction.guild!.id
          }/${correctionChannel}/${
            correction.message_id
          }), veuillez la désapprouver avant l'approbation de cette suggestion.`
        )
      );
    }

    const lastCorrection =
      proposal.type !== ProposalType.SUGGESTION &&
      proposal.suggestion!.corrections[0];
    if (lastCorrection && lastCorrection.id !== proposal.id) {
      return interaction.reply(
        interactionInfo(`
          Il semblerait qu'une [correction ai été ajoutée](https://discord.com/channels/${
            interaction.guild!.id
          }/${correctionChannel}/${
          lastCorrection.message_id
        }) par dessus rendant celle ci obselette, veuillez désapprouver la dernière version de la correction.`)
      );
    }

    if (
      proposal.disapprovals.some(
        (disapproval) => disapproval.user_id === interaction.user.id
      )
    ) {
      return interaction.reply(
        interactionInfo(
          `Vous avez déjà désapprouvé cette ${
            isSuggestion ? 'blague' : 'correction'
          }.`
        )
      );
    }

    const approvalIndex = proposal.approvals.findIndex(
      (approval) => approval.user_id === interaction.user.id
    );
    if (approvalIndex !== -1) {
      proposal.approvals.splice(approvalIndex, 1);
      await prisma.approval.delete({
        where: {
          proposal_id_user_id: {
            proposal_id: proposal.id,
            user_id: interaction.user.id
          }
        }
      });
    }

    proposal.disapprovals.push(
      await prisma.disapproval.create({
        data: {
          proposal_id: proposal.id,
          user_id: interaction.user.id
        }
      })
    );

    const godfathers = await renderGodfatherLine(interaction, proposal);

    if (proposal.type === ProposalType.SUGGESTION) {
      embed.description = `${
        embed.description!.split('\n\n')[0]
      }\n\n${godfathers}`;
    } else {
      embed.fields[1].value = `${
        embed.fields[1].value.split('\n\n')[0]
      }\n\n${godfathers}`;
    }

    if (proposal.disapprovals.length < neededApprovals) {
      await message.edit({ embeds: [embed] });

      return interaction.reply(
        interactionValidate(`Votre désapprobation a été prise en compte !`)
      );
    }

    return this.disapprove(interaction, proposal, message, embed);
  }

  async disapprove(
    interaction: CommandInteraction,
    proposal: Proposal,
    message: Message,
    embed: MessageEmbed
  ): Promise<void> {
    const isSuggestion = proposal.type === ProposalType.SUGGESTION;

    await prisma.proposal.update({
      data: { refused: true },
      where: { id: proposal.id }
    });

    embed.color = 0xff0000;
    if (isSuggestion) {
      embed.description = embed.description!.split('\n\n')[0];
    } else {
      embed.fields[1].value = embed.fields[1].value!.split('\n\n')[0];
    }
    embed.footer = {
      text: `${isSuggestion ? 'Suggestion' : 'Correction'} refusée`
    };

    await message.edit({ embeds: [embed] });

    await message.reactions.removeAll();

    return interaction.reply(
      interactionValidate(
        `La ${isSuggestion ? 'suggestion' : 'correction'} a bien été refusée !`
      )
    );
  }
}