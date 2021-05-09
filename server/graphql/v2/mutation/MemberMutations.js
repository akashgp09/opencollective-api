import { GraphQLBoolean, GraphQLNonNull, GraphQLString } from 'graphql';
import { pick } from 'lodash';

import MemberRoles from '../../../constants/roles';
import models from '../../../models';
import { editPublicMessage } from '../../common/members';
import { Forbidden, Unauthorized } from '../../errors';
import { MemberRole } from '../enum';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { MemberInvitationInput } from '../input/MemberInvitationInput';
import { Member } from '../object/Member';
import { MemberInvitation } from '../object/MemberInvitation';

const memberMutations = {
  editPublicMessage: {
    type: new GraphQLNonNull(Member),
    description: 'Edit the public message for the given Member of a Collective',
    args: {
      fromAccount: {
        type: GraphQLNonNull(AccountReferenceInput),
        description: 'Reference to an account for the donating Collective',
      },
      toAccount: {
        type: GraphQLNonNull(AccountReferenceInput),
        description: 'Reference to an account for the receiving Collective',
      },
      message: {
        type: GraphQLString,
        description: 'New public message',
      },
    },
    async resolve(_, args, req) {
      let { fromAccount, toAccount } = args;
      const { message } = args;

      toAccount = await fetchAccountWithReference(toAccount);
      fromAccount = await fetchAccountWithReference(fromAccount);

      return await editPublicMessage(
        _,
        {
          fromAccount,
          toAccount,
          message,
        },
        req,
      );
    },
  },
  inviteMember: {
    type: new GraphQLNonNull(MemberInvitation),
    description: 'Invite a new member to the Collective',
    args: {
      memberInvitation: {
        type: GraphQLNonNull(MemberInvitationInput),
        description: 'Reference to an account for the invitee',
      },
    },
    async resolve(_, args, req) {
      if (!req.remoteUser) {
        throw new Unauthorized('You need to be logged in to invite a member.');
      }

      let { memberAccount, account } = args.memberInvitation;

      memberAccount = await fetchAccountWithReference(memberAccount);
      account = await fetchAccountWithReference(account);

      if (!req.remoteUser.isAdminOfCollective(account)) {
        throw new Unauthorized('Only admins can send an invitation.');
      }

      const memberParams = {
        ...pick(args.memberInvitation, ['role', 'description', 'since']),
        MemberCollectiveId: memberAccount.id,
        CreatedByUserId: req.remoteUser.id,
      };

      // Invite member
      await models.MemberInvitation.invite(account, memberParams);

      const invitation = await models.MemberInvitation.findOne({
        where: {
          CollectiveId: account.id,
          MemberCollectiveId: memberParams.MemberCollectiveId,
        },
      });

      return invitation;
    },
  },
  removeMember: {
    type: GraphQLBoolean,
    description: 'Remove a member from the Collective',
    args: {
      memberAccount: {
        type: GraphQLNonNull(AccountReferenceInput),
        description: 'Reference to an account of member to remove',
      },
      account: {
        type: GraphQLNonNull(AccountReferenceInput),
        description: 'Reference to the Collective account',
      },
      role: {
        type: MemberRole,
        description: 'Role of member',
      },
    },
    async resolve(_, args, req) {
      if (!req.remoteUser) {
        throw new Unauthorized('You need to be logged in to remove a member.');
      }

      let { memberAccount, account } = args;

      memberAccount = await fetchAccountWithReference(memberAccount);
      account = await fetchAccountWithReference(account);

      if (!req.remoteUser.isAdminOfCollective(account)) {
        throw new Unauthorized('Only admins can remove a member.');
      }

      if (![MemberRoles.ACCOUNTANT, MemberRoles.ADMIN, MemberRoles.MEMBER].includes(args.role)) {
        throw new Forbidden('You can only remove accountants, admins, or members.');
      }

      // Remove member
      await models.Member.update({ deletedAt: new Date() }, { where: { id: memberAccount.id } });

      return true;
    },
  },
};

export default memberMutations;
